const express = require("express");
const axios = require("axios");
const cors = require("cors");
const session = require("express-session");
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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ─── 1. LOGIN COM META ───────────────────────────────────────────────────────

app.get("/auth/meta", (req, res) => {
  const scopes = "ads_management,ads_read,business_management";
  const url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${REDIRECT_URI}&scope=${scopes}&response_type=code`;
  res.redirect(url);
});

app.get("/auth/meta/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const tokenRes = await axios.get("https://graph.facebook.com/v19.0/oauth/access_token", {
      params: {
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        redirect_uri: REDIRECT_URI,
        code,
      },
    });
    req.session.accessToken = tokenRes.data.access_token;

    const adAccountsRes = await axios.get("https://graph.facebook.com/v19.0/me/adaccounts", {
      params: {
        access_token: req.session.accessToken,
        fields: "id,name,currency,account_status",
      },
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

// ─── 2. CHAT COM IA ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Você é um gestor de tráfego especialista em Meta Ads com acesso à API do Meta.
Quando o usuário pedir para criar uma campanha, conjunto de anúncios ou anúncio, responda com um JSON estruturado assim:

{
  "acao": "criar_campanha" | "criar_conjunto" | "criar_anuncio" | "listar_campanhas" | "pausar_campanha" | "resposta",
  "parametros": { ... parâmetros necessários ... },
  "mensagem": "explicação em português do que vai ser feito"
}

Para "resposta" (quando apenas responder sem criar nada), use:
{ "acao": "resposta", "parametros": {}, "mensagem": "sua resposta aqui" }

Parâmetros para criar_campanha:
- nome: string
- objetivo: "OUTCOME_LEADS" | "OUTCOME_SALES" | "OUTCOME_TRAFFIC" | "OUTCOME_AWARENESS" | "OUTCOME_ENGAGEMENT"
- status: "PAUSED" (sempre começar pausado para o usuário revisar)

Parâmetros para criar_conjunto:
- campanha_id: string (pedir ao usuário se não souber)
- nome: string
- orcamento_diario: number (em centavos, ex: 5000 = R$50)
- data_inicio: string (formato: "2024-01-15T00:00:00-0300")
- pais: string (ex: "BR")
- idade_min: number
- idade_max: number
- genero: 0 (todos) | 1 (masculino) | 2 (feminino)
- interesses: array de strings com nomes de interesses

Parâmetros para criar_anuncio:
- conjunto_id: string
- nome: string
- titulo: string
- texto: string
- url_destino: string
- cta: "LEARN_MORE" | "SIGN_UP" | "SHOP_NOW" | "CONTACT_US" | "DOWNLOAD"

Parâmetros para listar_campanhas: {}
Parâmetros para pausar_campanha: { campanha_id: string }

Sempre responda em JSON válido, sem texto fora do JSON.`;

// ✅ CORREÇÃO: removido o bloqueio por accessToken — chat funciona sem login
app.post("/chat", async (req, res) => {
  const { mensagens, contaId } = req.body;

  if (contaId) {
    req.session.contaId = contaId;
  }

  const estaLogado = !!req.session.accessToken;

  try {
    const iaRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: mensagens,
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
      }
    );

    const textoIA = iaRes.data.content[0].text;
    let resposta;
    try {
      resposta = JSON.parse(textoIA);
    } catch {
      return res.json({ mensagem: textoIA, acao: "resposta" });
    }

    // ✅ CORREÇÃO: se ação exige Meta Ads mas usuário não está logado, avisa
    const acoesQuePrecisamDeLogin = ["criar_campanha", "criar_conjunto", "criar_anuncio", "listar_campanhas", "pausar_campanha"];

    if (acoesQuePrecisamDeLogin.includes(resposta.acao) && !estaLogado) {
      return res.json({
        acao: "resposta",
        parametros: {},
        mensagem: `Entendi! ${resposta.mensagem}\n\nPara executar essa ação no Meta Ads, você precisa primeiro conectar sua conta do Facebook. Clique no botão **"Conectar com Facebook"** no topo da página e depois repita o pedido. 🚀`,
      });
    }

    if (resposta.acao === "resposta") {
      return res.json(resposta);
    }

    const resultado = await executarAcaoMeta(
      resposta.acao,
      resposta.parametros,
      req.session.accessToken,
      req.session.contaId
    );

    res.json({ ...resposta, resultado });
  } catch (err) {
    console.error("Erro no chat:", err.response?.data || err.message);
    res.status(500).json({ erro: "Erro interno", detalhe: err.message });
  }
});

// ─── 3. AÇÕES NO META ADS ────────────────────────────────────────────────────

async function executarAcaoMeta(acao, params, token, contaId) {
  const base = `https://graph.facebook.com/v19.0`;

  switch (acao) {
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
      if (params.genero && params.genero !== 0) {
        targeting.genders = [params.genero];
      }
      if (params.interesses?.length > 0) {
        const interessesIds = await buscarInteresses(params.interesses, token);
        if (interessesIds.length > 0) {
          targeting.flexible_spec = [{ interests: interessesIds }];
        }
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
      const criativoRes = await axios.post(`${base}/act_${contaId}/adcreatives`, {
        name: `${params.nome} - Criativo`,
        object_story_spec: {
          page_id: params.page_id,
          link_data: {
            message: params.texto,
            link: params.url_destino,
            name: params.titulo,
            call_to_action: { type: params.cta },
          },
        },
        access_token: token,
      });

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
      await axios.post(`${base}/${params.campanha_id}`, {
        status: "PAUSED",
        access_token: token,
      });
      return { mensagem: "Campanha pausada com sucesso" };
    }

    default:
      return { mensagem: "Ação não reconhecida" };
  }
}

async function buscarInteresses(nomes, token) {
  const resultados = [];
  for (const nome of nomes) {
    try {
      const res = await axios.get(`https://graph.facebook.com/v19.0/search`, {
        params: { type: "adinterest", q: nome, access_token: token },
      });
      if (res.data.data[0]) {
        resultados.push({ id: res.data.data[0].id, name: res.data.data[0].name });
      }
    } catch {}
  }
  return resultados;
}

// ─── 4. MÉTRICAS ─────────────────────────────────────────────────────────────

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

// ─── INICIAR SERVIDOR ────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));
