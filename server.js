require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

app.use(cors({
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-App-Role", "X-App-Username"],
}));
app.use(express.json());

app.use((req, _res, next) => {
  console.log("REQ:", req.method, req.url);
  next();
});

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT || 5432),
});

const shiftLabels = ["1º turno", "2º turno", "3º turno"];

function getRoleCredentials() {
  return [
    {
      role: "operador",
      username: process.env.API_OPERATOR_USER,
      password: process.env.API_OPERATOR_PASS,
    },
    {
      role: "gestor",
      username: process.env.API_MANAGER_USER,
      password: process.env.API_MANAGER_PASS,
    },
    {
      role: "ti",
      username: process.env.API_IT_USER,
      password: process.env.API_IT_PASS,
    },
  ].filter((item) => item.username && item.password);
}

function getServerCredentials() {
  const username = process.env.API_SERVER_USER || process.env.DB_USER;
  const password = process.env.API_SERVER_PASS || process.env.DB_PASSWORD;

  if (!username || !password) {
    return null;
  }

  return {
    username,
    password,
  };
}

function parseAuthHeader(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return null;
  }

  const encoded = authHeader.split(" ")[1];
  const decoded = Buffer.from(encoded, "base64").toString("utf-8");
  const separatorIndex = decoded.indexOf(":");

  if (separatorIndex === -1) {
    return null;
  }

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1),
  };
}

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase();
}

function authenticate(req, res, next) {
  const parsed = parseAuthHeader(req);

  if (!parsed) {
    return res.status(401).json({ erro: "Autenticação obrigatória" });
  }

  const { username, password } = parsed;
  const roleCredentials = getRoleCredentials();
  const matchedRole = roleCredentials.find(
    (item) => item.username === username && item.password === password
  );

  if (matchedRole) {
    req.user = {
      username,
      role: normalizeRole(matchedRole.role),
    };
    return next();
  }

  const serverCredentials = getServerCredentials();
  const matchedServer =
    serverCredentials &&
    serverCredentials.username === username &&
    serverCredentials.password === password;

  if (!matchedServer) {
    return res.status(401).json({ erro: "Usuário ou senha inválidos" });
  }

  const appRole = normalizeRole(req.headers["x-app-role"]) || "operador";

  req.user = {
    username,
    role: appRole,
  };

  next();
}

function requireManagerOrIT(req, res, next) {
  const role = normalizeRole(req.user?.role);
  console.log("ROLE RECEBIDO:", role);

  if (!["operador", "gestor", "ti"].includes(role)) {
    return res.status(403).json({ erro: "Sem permissão para esta ação." });
  }

  next();
}

app.get("/", (_req, res) => {
  res.send("API Coletor de Falhas funcionando");
});

app.get("/about", (_req, res) => {
  res.json({
    system: "Coletor de Falhas",
    version: "2.1",
    purpose: "Registro, histórico e análise preventiva de falhas operacionais.",
    developer: "Nicolas Batista",
    year: 2026,
    stack: {
      frontend: "React + Capacitor",
      backend: "Node.js + Express",
      database: "PostgreSQL"
    }
  });
});

app.post("/auth/login", (req, res) => {
  const { username, password } = req.body;

  const users = getRoleCredentials();

  const found = users.find(
    (u) => u.username === username && u.password === password
  );

  if (!found) {
    return res.status(401).json({ erro: "Usuário ou senha inválidos" });
  }

  return res.json({
    username: found.username,
    role: found.role,
    canDelete: ["gestor", "ti"].includes(found.role),
    shifts: shiftLabels,
  });
});

app.get("/failures", authenticate, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        id,
        machine AS maquina,
        product AS produto,
        problem AS problema,
        cause AS causa,
        solution AS solucao,
        operator AS operador,
        maintenance AS manutencao,
        created_at AS "dataHora",
        COALESCE(tempo_perdido_min, 0) AS "tempoPerdidoMin",
        COALESCE(status, 'aberta') AS status,
        resolved_shift AS "turnoResolvido",
        resolved_at AS "resolvidoEm",
        resolved_by_role AS "resolvidoPorPerfil"
      FROM failures
      ORDER BY created_at DESC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Erro no GET /failures:", error);
    res.status(500).json({ erro: error.message });
  }
});

app.post("/failures", authenticate, async (req, res) => {
  try {
    const {
      maquina,
      produto,
      problema,
      causa,
      solucao,
      operador,
      manutencao,
      tempoPerdidoMin,
    } = req.body;

    const result = await pool.query(
      `INSERT INTO failures
        (machine, product, problem, cause, solution, operator, maintenance, tempo_perdido_min, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'aberta')
       RETURNING
        id,
        machine AS maquina,
        product AS produto,
        problem AS problema,
        cause AS causa,
        solution AS solucao,
        operator AS operador,
        maintenance AS manutencao,
        created_at AS "dataHora",
        COALESCE(tempo_perdido_min, 0) AS "tempoPerdidoMin",
        COALESCE(status, 'aberta') AS status,
        resolved_shift AS "turnoResolvido",
        resolved_at AS "resolvidoEm",
        resolved_by_role AS "resolvidoPorPerfil"`,
      [
        maquina,
        produto,
        problema,
        causa,
        solucao,
        operador,
        manutencao || null,
        Number(tempoPerdidoMin || 0),
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Erro no POST /failures:", error);
    res.status(500).json({ erro: error.message });
  }
});

app.put("/failures/:id/resolve", authenticate, requireManagerOrIT, async (req, res) => {
  try {
    const { id } = req.params;
    const shift = String(req.body?.shift || "").trim();

    if (!shiftLabels.includes(shift)) {
      return res.status(400).json({ erro: "Turno inválido." });
    }

    const result = await pool.query(
      `UPDATE failures
       SET status = 'resolvida',
           resolved_at = NOW(),
           resolved_shift = $1,
           resolved_by_role = $2
       WHERE id = $3
       RETURNING
         id,
         machine AS maquina,
         product AS produto,
         problem AS problema,
         cause AS causa,
         solution AS solucao,
         operator AS operador,
         maintenance AS manutencao,
         created_at AS "dataHora",
         COALESCE(tempo_perdido_min, 0) AS "tempoPerdidoMin",
         COALESCE(status, 'aberta') AS status,
         resolved_shift AS "turnoResolvido",
         resolved_at AS "resolvidoEm",
         resolved_by_role AS "resolvidoPorPerfil"`,
      [shift, req.user.role, id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ erro: "Registro não encontrado." });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Erro no PUT /failures/:id/resolve:", error);
    res.status(500).json({ erro: error.message });
  }
});

app.get("/failures/similar", authenticate, async (req, res) => {
  try {
    const machine = String(req.query.machine || "").trim();
    const product = String(req.query.product || "").trim();
    const problem = String(req.query.problem || "").trim();
    const cause = String(req.query.cause || "").trim();

    if (!product || (!problem && !cause)) {
      return res.json([]);
    }

    const productLike = `%${product}%`;
    const problemLike = `%${problem}%`;
    const causeLike = `%${cause}%`;

    const result = await pool.query(
      `SELECT
         id,
         machine AS maquina,
         product AS produto,
         problem AS problema,
         cause AS causa,
         solution AS solucao,
         operator AS operador,
         maintenance AS manutencao,
         created_at AS "dataHora",
         COALESCE(tempo_perdido_min, 0) AS "tempoPerdidoMin",
         COALESCE(status, 'aberta') AS status,
         resolved_shift AS "turnoResolvido",
         resolved_at AS "resolvidoEm",
         resolved_by_role AS "resolvidoPorPerfil",
         (
           CASE WHEN machine <> $1 THEN 2 ELSE 0 END +
           CASE WHEN problem ILIKE $3 THEN 3 ELSE 0 END +
           CASE WHEN cause <> '' AND cause ILIKE $4 THEN 2 ELSE 0 END +
           CASE WHEN COALESCE(status, 'aberta') = 'resolvida' THEN 1 ELSE 0 END
         ) AS score
       FROM failures
       WHERE product ILIKE $2
         AND (
           ($3 <> '%%' AND problem ILIKE $3)
           OR ($4 <> '%%' AND cause ILIKE $4)
         )
       ORDER BY score DESC, created_at DESC
       LIMIT 5`,
      [machine, productLike, problemLike, causeLike]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Erro no GET /failures/similar:", error);
    res.status(500).json({ erro: error.message || "Erro ao buscar soluções semelhantes." });
  }
});

app.get("/failures/insights", authenticate, async (req, res) => {
  try {
    const { machine, product } = req.query;

    if (!machine) {
      return res.status(400).json({ erro: "Parâmetro machine é obrigatório." });
    }

    const values = [machine];
    let where = `WHERE machine = $1`;

    if (product) {
      values.push(product);
      where += ` AND product = $2`;
    }

    const result = await pool.query(
      `SELECT machine, product, problem, cause, solution, COALESCE(tempo_perdido_min, 0) AS tempo_perdido_min
       FROM failures
       ${where}`,
      values
    );

    const rows = result.rows;

    const countMap = (items, key) => {
      const map = new Map();
      for (const item of items) {
        const value = String(item[key] || "").trim();
        if (!value) continue;
        map.set(value, (map.get(value) || 0) + 1);
      }
      return [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([texto, ocorrencias]) => ({ texto, ocorrencias }));
    };

    const problemas = countMap(rows, "problem").slice(0, 5);
    const causas = countMap(rows, "cause").slice(0, 5);
    const solucoes = countMap(rows, "solution").slice(0, 5);

    const totalOcorrencias = rows.length;
    const totalMinutos = rows.reduce((acc, r) => acc + Number(r.tempo_perdido_min || 0), 0);

    let risco = "BAIXO";
    if (totalMinutos >= 120) risco = "ALTO";
    else if (totalMinutos >= 40) risco = "MÉDIO";

    const observacoes = [];
    if (problemas[0]) observacoes.push(`Revisar ponto crítico: ${problemas[0].texto}.`);
    if (causas[0]) observacoes.push(`Causa recorrente: ${causas[0].texto}.`);
    if (solucoes[0]) observacoes.push(`Solução mais aplicada: ${solucoes[0].texto}.`);
    if (totalMinutos > 0) observacoes.push(`Tempo perdido acumulado: ${totalMinutos} min.`);
    if (totalOcorrencias > 0) observacoes.push(`Histórico encontrado: ${totalOcorrencias} ocorrência(s).`);

    res.json({
      totalOcorrencias,
      totalMinutos,
      risco,
      problemas,
      causas,
      solucoes,
      observacoes: [...new Set(observacoes)].slice(0, 8),
    });
  } catch (error) {
    console.error("Erro no GET /failures/insights:", error);
    res.status(500).json({ erro: error.message || "Erro ao gerar insights." });
  }
});

app.delete("/failures/:id", authenticate, requireManagerOrIT, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM failures WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (error) {
    console.error("Erro no DELETE /failures/:id:", error);
    res.status(500).json({ erro: error.message });
  }
});

const port = Number(process.env.APP_PORT || 3000);

app.listen(port, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${port}`);
  console.log("Servidor acessível na rede local.");
});
