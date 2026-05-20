const express = require("express");
const axios = require("axios");
const cors = require("cors");
const session = require("express-session");
const FormData = require("form-data");
require("dotenv").config();

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(session({
  secret: process.env.SESSION_SECRET || "segredo-trocar",
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    secure: true,
    sameSite: "none",
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

// ─── DEFAULTS DA CONTA CAMILA RIBEIRO ────────────────────────────────────────
const DEFAULT_AD_ACCOUNT_ID = "930352218525296";
const DEFAULT_PAGE_ID = "256323230887336";

// ─── VALIDAÇÃO DA API KEY NO STARTUP ─────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("🚨 ERRO CRÍTICO: ANTHROPIC_API_KEY não encontrada!");
} else {
  console.log("✅ ANTHROPIC_API_KEY carregada:", ANTHROPIC_API_KEY.substring(0, 20) + "...");
}

// ─── 1. LOGIN COM META ────────────────────────────────────────────────────────
app.get("/auth/meta", (req, res) => {
  const scopes = "ads_management,ads_read,business_management";
  const url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${REDIRECT_URI}&scope=${scopes}&response_type=code`;
  res.redirect(url);
});

app.get("/auth/meta/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const tokenRes = await axios.get("https://graph.facebook.com/v19.0/oauth/access_token", {
      params: { client_id: META_APP_ID, client_secret: META_APP_SECRET, redirect_uri: REDIRECT_URI, code },
    });
    req.session.accessToken = tokenRes.data.access_token;

    const adAccountsRes = await axios.get("https://graph.facebook.com/v19.0/me/adaccounts", {
      params: { access_token: req.session.accessToken, fields: "id,name,currency,account_status" },
    });
    req.session.adAccounts = adAccountsRes.data.data;

    req.session.save((err) => {
      if (err) console.error("Erro ao salvar sessão:", err);
      res.redirect(`${process.env.FRONTEND_URL}?logado=true`);
    });
  } catch (err) {
    console.error("Erro no login:", err.response?.data || err.message);
    res.redirect(`${process.env.FRONTEND_URL}?erro=login`);
  }
});

app.get("/auth/status", (req, res) => {
  if (req.session.accessToken) {
    res.json({ logado: true, contas: req.session.adAccounts });
  } else {
    res.json({ logado: false });
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ─── 2. UPLOAD DE MÍDIA PARA O META ──────────────────────────────────────────

// Converte link do Google Drive para link de download direto
function converterLinkDrive(url) {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) {
    return `https://drive.google.com/uc?export=download&id=${match[1]}`;
  }
  return url;
}

// Detecta tipo de mídia pela URL
function detectarTipoMidia(url) {
  const lower = url.toLowerCase();
  if (lower.includes("instagram.com")) return "instagram";
  if (lower.includes("drive.google.com")) return "google_drive";
  if (lower.match(/\.(mp4|mov|avi|wmv|flv|webm)/)) return "video";
  if (lower.match(/\.(jpg|jpeg|png|gif|webp)/)) return "imagem";
  return "url_generica";
}

// Faz upload de vídeo para o Meta via URL
async function uploadVideoMeta(urlMidia, contaId, token) {
  const urlDownload = converterLinkDrive(urlMidia);
  console.log("📤 Iniciando upload de vídeo para o Meta:", urlDownload);

  // Inicia upload de vídeo via URL
  const uploadRes = await axios.post(
    `https://graph.facebook.com/v19.0/act_${contaId}/advideos`,
    {
      file_url: urlDownload,
      access_token: token,
    }
  );

  console.log("✅ Vídeo enviado, ID:", uploadRes.data.id);
  return uploadRes.data.id;
}

// Faz upload de imagem para o Meta via URL
async function uploadImagemMeta(urlMidia, contaId, token) {
  const urlDownload = converterLinkDrive(urlMidia);
  console.log("📤 Iniciando upload de imagem para o Meta:", urlDownload);

  const uploadRes = await axios.post(
    `https://graph.facebook.com/v19.0/act_${contaId}/adimages`,
    {
      url: urlDownload,
      access_token: token,
    }
  );

  const hashImagem = Object.values(uploadRes.data.images)[0].hash;
  console.log("✅ Imagem enviada, hash:", hashImagem);
  return hashImagem;
}

// ─── 3. SISTEMA PROMPT DA IA ──────────────────────────────────────────────────
const SYSTEM_PROMPT = `Você é um gestor de tráfego especialista em Meta Ads integrado à API do Meta.
Conta de anúncios padrão: ${DEFAULT_AD_ACCOUNT_ID} (Nova C.A. Camila Jan-24)
Página do Facebook padrão: ${DEFAULT_PAGE_ID} (Camila Ribeiro / @camilaribeiromentora)

Quando o usuário pedir para criar uma campanha completa, responda com um JSON assim:

{
  "acao": "criar_campanha_completa",
  "parametros": {
    "campanha": {
      "nome": string,
      "objetivo": "OUTCOME_LEADS" | "OUTCOME_SALES" | "OUTCOME_TRAFFIC" | "OUTCOME_AWARENESS" | "OUTCOME_ENGAGEMENT"
    },
    "conjunto": {
      "nome": string,
      "orcamento_diario": number (em centavos, R$10 = 1000),
      "data_inicio": string (formato: "2026-05-20T00:00:00-0300"),
      "pais": "BR",
      "idade_min": number,
      "idade_max": number,
      "genero": 0 | 1 | 2,
      "interesses": array de strings
    },
    "anuncio": {
      "nome": string,
      "titulo": string,
      "texto": string,
      "url_destino": string,
      "cta": "LEARN_MORE" | "SIGN_UP" | "SHOP_NOW" | "CONTACT_US" | "DOWNLOAD",
      "url_midia": string (URL do Google Drive ou Instagram fornecida pelo usuário, se houver),
      "tipo_midia": "video" | "imagem" | "carrossel" | null
    }
  },
  "mensagem": "explicação do que vai ser criado"
}

Para outras ações:
{
  "acao": "criar_campanha" | "criar_conjunto" | "criar_anuncio" | "listar_campanhas" | "pausar_campanha" | "ativar_campanha" | "analisar_resultados" | "resposta",
  "parametros": { ... },
  "mensagem": "explicação"
}

Parâmetros para criar_campanha:
- nome, objetivo, status: "PAUSED"

Parâmetros para criar_conjunto:
- campanha_id, nome, orcamento_diario (centavos), data_inicio, pais, idade_min, idade_max, genero, interesses

Parâmetros para criar_anuncio:
- conjunto_id, nome, titulo, texto, url_destino, cta, url_midia (opcional), tipo_midia (opcional)

Parâmetros para listar_campanhas: {}
Parâmetros para pausar_campanha: { campanha_id }
Parâmetros para ativar_campanha: { campanha_id }
Parâmetros para analisar_resultados: { periodo: "last_7d" | "last_30d" | "last_90d" }

Para "resposta": { "acao": "resposta", "parametros": {}, "mensagem": "sua resposta" }

IMPORTANTE:
- Sempre use a conta e página padrão a menos que o usuário especifique outra
- Sempre crie campanhas com status PAUSED para revisão
- Quando o usuário enviar link do Google Drive ou Instagram, use como url_midia
- Para campanhas completas, use sempre criar_campanha_completa para criar tudo de uma vez
- Sempre responda em JSON válido, sem texto fora do JSON`;

// ─── 4. CHAT COM IA ───────────────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  const { mensagens, contaId } = req.body;

  if (contaId) req.session.contaId = contaId;

  const estaLogado = !!req.session.accessToken;
  const contaAtiva = req.session.contaId || DEFAULT_AD_ACCOUNT_ID;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    console.error("🚨 /chat: ANTHROPIC_API_KEY está vazia!");
    return res.status(500).json({ erro: "API key da IA não configurada." });
  }

  console.log(`📨 /chat | logado: ${estaLogado} | conta: ${contaAtiva}`);

  try {
    const iaRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: mensagens,
      },
      {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
      }
    );

    const textoIA = iaRes.data.content[0].text;
    console.log("📝 Resposta IA:", textoIA.substring(0, 300));

    let resposta;
    try {
      const limpo = textoIA.replace(/```json|```/g, "").trim();
      resposta = JSON.parse(limpo);
    } catch {
      return res.json({ mensagem: textoIA, acao: "resposta" });
    }

    const acoesQuePrecisamDeLogin = ["criar_campanha", "criar_conjunto", "criar_anuncio", "criar_campanha_completa", "listar_campanhas", "pausar_campanha", "ativar_campanha", "analisar_resultados"];

    if (acoesQuePrecisamDeLogin.includes(resposta.acao) && !estaLogado) {
      return res.json({
        acao: "resposta",
        mensagem: `Entendi! ${resposta.mensagem}\n\nPara executar essa ação, conecte sua conta do Facebook primeiro. 🚀`,
      });
    }

    if (resposta.acao === "resposta") {
      return res.json(resposta);
    }

    // Executa ação no Meta
    const resultado = await executarAcaoMeta(
      resposta.acao,
      resposta.parametros,
      req.session.accessToken,
      contaAtiva
    );

    res.json({ ...resposta, resultado });

  } catch (err) {
    const erroDetalhado = err.response?.data || err.message;
    console.error("🚨 Erro no /chat:", JSON.stringify(erroDetalhado, null, 2));
    if (err.response?.status === 401) console.error("🔑 API key inválida.");
    if (err.response?.status === 404) console.error("❌ Modelo não encontrado.");
    res.status(500).json({ erro: "Erro ao chamar a IA", detalhe: erroDetalhado });
  }
});

// ─── 5. AÇÕES NO META ADS ─────────────────────────────────────────────────────
async function executarAcaoMeta(acao, params, token, contaId) {
  const base = "https://graph.facebook.com/v19.0";

  switch (acao) {

    // ── CRIAR CAMPANHA COMPLETA (campanha + conjunto + criativo + anúncio) ──
    case "criar_campanha_completa": {
      console.log("🚀 Criando campanha completa...");

      // 1. Cria campanha
      const campanhaRes = await axios.post(`${base}/act_${contaId}/campaigns`, {
        name: params.campanha.nome,
        objective: params.campanha.objetivo,
        status: "PAUSED",
        special_ad_categories: [],
        access_token: token,
      });
      const campanhaId = campanhaRes.data.id;
      console.log("✅ Campanha criada:", campanhaId);

      // 2. Busca interesses
      let targeting = {
        geo_locations: { countries: [params.conjunto.pais || "BR"] },
        age_min: params.conjunto.idade_min || 18,
        age_max: params.conjunto.idade_max || 65,
      };
      if (params.conjunto.genero && params.conjunto.genero !== 0) {
        targeting.genders = [params.conjunto.genero];
      }
      if (params.conjunto.interesses?.length > 0) {
        const interessesIds = await buscarInteresses(params.conjunto.interesses, token);
        if (interessesIds.length > 0) {
          targeting.flexible_spec = [{ interests: interessesIds }];
        }
      }

      // 3. Cria conjunto de anúncios
      const conjuntoRes = await axios.post(`${base}/${campanhaId}/adsets`, {
        name: params.conjunto.nome,
        daily_budget: params.conjunto.orcamento_diario,
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        billing_event: "IMPRESSIONS",
        optimization_goal: params.campanha.objetivo === "OUTCOME_LEADS" ? "LEAD_GENERATION" : "LINK_CLICKS",
        start_time: params.conjunto.data_inicio,
        targeting,
        status: "PAUSED",
        access_token: token,
      });
      const conjuntoId = conjuntoRes.data.id;
      console.log("✅ Conjunto criado:", conjuntoId);

      // 4. Cria criativo (com ou sem mídia)
      let criativoData = {
        name: `${params.anuncio.nome} - Criativo`,
        access_token: token,
      };

      if (params.anuncio.url_midia) {
        const tipoMidia = detectarTipoMidia(params.anuncio.url_midia);
        console.log("🎨 Tipo de mídia detectado:", tipoMidia);

        if (tipoMidia === "video" || tipoMidia === "google_drive") {
          // Upload de vídeo
          const videoId = await uploadVideoMeta(params.anuncio.url_midia, contaId, token);
          criativoData.object_story_spec = {
            page_id: DEFAULT_PAGE_ID,
            video_data: {
              video_id: videoId,
              message: params.anuncio.texto,
              title: params.anuncio.titulo,
              call_to_action: {
                type: params.anuncio.cta,
                value: { link: params.anuncio.url_destino },
              },
            },
          };
        } else if (tipoMidia === "imagem") {
          // Upload de imagem
          const hashImagem = await uploadImagemMeta(params.anuncio.url_midia, contaId, token);
          criativoData.object_story_spec = {
            page_id: DEFAULT_PAGE_ID,
            link_data: {
              message: params.anuncio.texto,
              link: params.anuncio.url_destino,
              name: params.anuncio.titulo,
              image_hash: hashImagem,
              call_to_action: { type: params.anuncio.cta },
            },
          };
        } else if (tipoMidia === "instagram") {
          // Post do Instagram como criativo
          criativoData.object_story_spec = {
            page_id: DEFAULT_PAGE_ID,
            link_data: {
              message: params.anuncio.texto,
              link: params.anuncio.url_midia,
              name: params.anuncio.titulo,
              call_to_action: { type: params.anuncio.cta },
            },
          };
        }
      } else {
        // Sem mídia — criativo apenas com texto e link
        criativoData.object_story_spec = {
          page_id: DEFAULT_PAGE_ID,
          link_data: {
            message: params.anuncio.texto,
            link: params.anuncio.url_destino,
            name: params.anuncio.titulo,
            call_to_action: { type: params.anuncio.cta },
          },
        };
      }

      const criativoRes = await axios.post(`${base}/act_${contaId}/adcreatives`, criativoData);
      const criativoId = criativoRes.data.id;
      console.log("✅ Criativo criado:", criativoId);

      // 5. Cria anúncio
      const anuncioRes = await axios.post(`${base}/act_${contaId}/ads`, {
        name: params.anuncio.nome,
        adset_id: conjuntoId,
        creative: { creative_id: criativoId },
        status: "PAUSED",
        access_token: token,
      });
      const anuncioId = anuncioRes.data.id;
      console.log("✅ Anúncio criado:", anuncioId);

      return {
        sucesso: true,
        campanha_id: campanhaId,
        conjunto_id: conjuntoId,
        criativo_id: criativoId,
        anuncio_id: anuncioId,
        mensagem: `✅ Campanha completa criada com sucesso!\n\n📣 Campanha: ${campanhaId}\n🎯 Conjunto: ${conjuntoId}\n🎨 Criativo: ${criativoId}\n📝 Anúncio: ${anuncioId}\n\nTudo está PAUSADO. Revise no Meta Ads Manager e ative quando estiver pronto.`,
      };
    }

    case "criar_campanha": {
      const res = await axios.post(`${base}/act_${contaId}/campaigns`, {
        name: params.nome,
        objective: params.objetivo,
        status: "PAUSED",
        special_ad_categories: [],
        access_token: token,
      });
      return { id: res.data.id, mensagem: `Campanha criada com ID: ${res.data.id}` };
    }

    case "criar_conjunto": {
      let targeting = {
        geo_locations: { countries: [params.pais || "BR"] },
        age_min: params.idade_min || 18,
        age_max: params.idade_max || 65,
      };
      if (params.genero && params.genero !== 0) targeting.genders = [params.genero];
      if (params.interesses?.length > 0) {
        const ids = await buscarInteresses(params.interesses, token);
        if (ids.length > 0) targeting.flexible_spec = [{ interests: ids }];
      }
      const res = await axios.post(`${base}/${params.campanha_id}/adsets`, {
        name: params.nome,
        daily_budget: params.orcamento_diario,
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        billing_event: "IMPRESSIONS",
        optimization_goal: "LEAD_GENERATION",
        start_time: params.data_inicio,
        targeting,
        status: "PAUSED",
        access_token: token,
      });
      return { id: res.data.id, mensagem: `Conjunto criado com ID: ${res.data.id}` };
    }

    case "criar_anuncio": {
      let criativoData = {
        name: `${params.nome} - Criativo`,
        access_token: token,
      };

      if (params.url_midia) {
        const tipo = detectarTipoMidia(params.url_midia);
        if (tipo === "video" || tipo === "google_drive") {
          const videoId = await uploadVideoMeta(params.url_midia, contaId, token);
          criativoData.object_story_spec = {
            page_id: params.page_id || DEFAULT_PAGE_ID,
            video_data: {
              video_id: videoId,
              message: params.texto,
              title: params.titulo,
              call_to_action: { type: params.cta, value: { link: params.url_destino } },
            },
          };
        } else {
          const hash = await uploadImagemMeta(params.url_midia, contaId, token);
          criativoData.object_story_spec = {
            page_id: params.page_id || DEFAULT_PAGE_ID,
            link_data: {
              message: params.texto,
              link: params.url_destino,
              name: params.titulo,
              image_hash: hash,
              call_to_action: { type: params.cta },
            },
          };
        }
      } else {
        criativoData.object_story_spec = {
          page_id: params.page_id || DEFAULT_PAGE_ID,
          link_data: {
            message: params.texto,
            link: params.url_destino,
            name: params.titulo,
            call_to_action: { type: params.cta },
          },
        };
      }

      const criativoRes = await axios.post(`${base}/act_${contaId}/adcreatives`, criativoData);
      const anuncioRes = await axios.post(`${base}/act_${contaId}/ads`, {
        name: params.nome,
        adset_id: params.conjunto_id,
        creative: { creative_id: criativoRes.data.id },
        status: "PAUSED",
        access_token: token,
      });
      return { id: anuncioRes.data.id, mensagem: `Anúncio criado com ID: ${anuncioRes.data.id}` };
    }

    case "listar_campanhas": {
      const res = await axios.get(`${base}/act_${contaId}/campaigns`, {
        params: {
          fields: "id,name,status,objective,daily_budget,insights{spend,impressions,clicks,ctr}",
          access_token: token,
        },
      });
      return { campanhas: res.data.data };
    }

    case "pausar_campanha": {
      await axios.post(`${base}/${params.campanha_id}`, { status: "PAUSED", access_token: token });
      return { mensagem: "Campanha pausada com sucesso" };
    }

    case "ativar_campanha": {
      await axios.post(`${base}/${params.campanha_id}`, { status: "ACTIVE", access_token: token });
      return { mensagem: "Campanha ativada com sucesso" };
    }

    case "analisar_resultados": {
      const periodo = params.periodo || "last_7d";
      const res = await axios.get(`${base}/act_${contaId}/insights`, {
        params: {
          fields: "campaign_name,spend,impressions,clicks,ctr,cpm,cpp,actions,cost_per_action_type",
          date_preset: periodo,
          level: "campaign",
          access_token: token,
        },
      });
      return { resultados: res.data.data, periodo };
    }

    default:
      return { mensagem: "Ação não reconhecida" };
  }
}

async function buscarInteresses(nomes, token) {
  const resultados = [];
  for (const nome of nomes) {
    try {
      const res = await axios.get("https://graph.facebook.com/v19.0/search", {
        params: { type: "adinterest", q: nome, access_token: token },
      });
      if (res.data.data[0]) {
        resultados.push({ id: res.data.data[0].id, name: res.data.data[0].name });
      }
    } catch {}
  }
  return resultados;
}

// ─── 6. MÉTRICAS ──────────────────────────────────────────────────────────────
app.get("/metricas/:contaId", async (req, res) => {
  if (!req.session.accessToken) return res.status(401).json({ erro: "Não autenticado" });
  try {
    const { contaId } = req.params;
    const metricasRes = await axios.get(
      `https://graph.facebook.com/v19.0/act_${contaId}/insights`,
      {
        params: {
          fields: "spend,impressions,clicks,ctr,cpm,cpp,actions",
          date_preset: "last_7d",
          access_token: req.session.accessToken,
        },
      }
    );
    res.json(metricasRes.data.data[0] || {});
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── INICIAR SERVIDOR ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  console.log(`🌐 FRONTEND_URL: ${process.env.FRONTEND_URL}`);
  console.log(`🔑 ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY ? "✅ configurada" : "🚨 AUSENTE"}`);
  console.log(`📘 Conta padrão: ${DEFAULT_AD_ACCOUNT_ID}`);
  console.log(`📄 Página padrão: ${DEFAULT_PAGE_ID}`);
});
