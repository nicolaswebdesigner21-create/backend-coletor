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

const isRenderDatabaseUrl = Boolean(process.env.DATABASE_URL);

const pool = isRenderDatabaseUrl
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: Number(process.env.DB_PORT || 5432),
    });

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS failures (
        id SERIAL PRIMARY KEY,
        machine TEXT,
        product TEXT,
        problem TEXT,
        cause TEXT,
        solution TEXT,
        operator TEXT,
        maintenance TEXT,
        tempo_perdido_min INTEGER DEFAULT 0,
        status TEXT DEFAULT 'aberta',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        resolved_shift TEXT,
        resolved_at TIMESTAMP,
        resolved_by_role TEXT
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS machines (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT DEFAULT 'Cadastrada',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS machines_name_unique_idx
      ON machines (LOWER(name));
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        machine TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS products_name_machine_unique_idx
      ON products (LOWER(name), COALESCE(LOWER(machine), ''));
    `);

    for (const machine of defaultMachines) {
      await upsertMachine(machine.name, machine.category);
    }

    for (const product of defaultProducts) {
      await upsertProduct(product.name, product.machine);
    }

    await pool.query(`
      INSERT INTO machines (name, category)
      SELECT DISTINCT TRIM(machine), 'Histórico'
      FROM failures
      WHERE TRIM(COALESCE(machine, '')) <> ''
      ON CONFLICT (LOWER(name)) DO NOTHING;
    `);

    await pool.query(`
      INSERT INTO products (name, machine)
      SELECT DISTINCT TRIM(product), NULLIF(TRIM(machine), '')
      FROM failures
      WHERE TRIM(COALESCE(product, '')) <> ''
      ON CONFLICT (LOWER(name), COALESCE(LOWER(machine), '')) DO NOTHING;
    `);

    console.log("✅ Banco pronto");
  } catch (err) {
    console.error("❌ Erro ao criar banco:", err);
  }
}

const shiftLabels = ["1º turno", "2º turno", "3º turno"];

const defaultMachines = [
  { name: "Noack 920", category: "Primária" },
  { name: "IMA 1", category: "Primária" },
  { name: "IMA 2", category: "Primária" },
  { name: "Bolsar 1", category: "Primária" },
  { name: "Bolsar 2", category: "Primária" },
  { name: "Ulmhann", category: "Primária" },
  { name: "Cartopac", category: "Secundária" },
  { name: "IMA 1 Encartuchadeira", category: "Secundária" },
  { name: "IMA 2 Encartuchadeira", category: "Secundária" },
  { name: "Uhlmann encartuchadeira", category: "Secundária" },
  { name: "Verttopac", category: "Secundária" },
];

const defaultProducts = [
  { name: "Ciprofibrato 100mg x30", machine: "IMA 1" },
  { name: "Carvedilol 100mg x30", machine: "IMA 1" },
  { name: "Pantogar", machine: "IMA 1" },
  { name: "Gabapentina 100mg x30", machine: "IMA 2" },
  { name: "E-casil 15mg x30", machine: "IMA 2" },
  { name: "Vasopril 15mg x30", machine: "IMA 2" },
  { name: "Remédio 1", machine: "Ulmhann" },
  { name: "Remédio 2", machine: "Ulmhann" },
  { name: "Remédio 3", machine: "Ulmhann" },
];

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const synonymGroups = [
  ["leitura", "sensor", "scanner", "pharmacode", "codigo", "camera", "visao", "reader"],
  ["travamento", "travou", "bloqueio", "parada", "agarrou", "enrosco", "emperrou"],
  ["cartucho", "cartucheira", "encartuchadeira", "caixa"],
  ["blister", "deposito", "magazine", "alinhamento"],
  ["cola", "nordson", "bico", "hotmelt", "problue"],
  ["solda", "selagem", "temperatura", "aluminio", "pvc"],
  ["datador", "impressao", "lote", "validade", "carimbo"],
  ["sensor", "fotocelula", "sinal", "detector"],
];

function expandKeywords(value) {
  const tokens = new Set(normalizeText(value).split(" ").filter((word) => word.length >= 3));
  for (const group of synonymGroups) {
    if (group.some((term) => tokens.has(term))) {
      group.forEach((term) => tokens.add(term));
    }
  }
  return tokens;
}

function textIncludesAny(text, tokens) {
  const normalized = normalizeText(text);
  for (const token of tokens) {
    if (token.length >= 3 && normalized.includes(token)) return true;
  }
  return false;
}

async function upsertMachine(name, category = "Cadastrada") {
  const cleanName = String(name || "").trim();
  if (!cleanName) return null;
  const result = await pool.query(
    `INSERT INTO machines (name, category)
     VALUES ($1, $2)
     ON CONFLICT (LOWER(name)) DO UPDATE SET category = COALESCE(EXCLUDED.category, machines.category)
     RETURNING id, name, category`,
    [cleanName, category || "Cadastrada"]
  );
  return result.rows[0];
}

async function upsertProduct(name, machine = null) {
  const cleanName = String(name || "").trim();
  const cleanMachine = String(machine || "").trim() || null;
  if (!cleanName) return null;
  const result = await pool.query(
    `INSERT INTO products (name, machine)
     VALUES ($1, $2)
     ON CONFLICT (LOWER(name), COALESCE(LOWER(machine), '')) DO UPDATE SET machine = EXCLUDED.machine
     RETURNING id, name, machine`,
    [cleanName, cleanMachine]
  );
  return result.rows[0];
}

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

function requireResolvePermission(req, res, next) {
  const role = normalizeRole(req.user?.role);
  console.log("ROLE RECEBIDO:", role);

  if (!["operador", "gestor", "ti"].includes(role)) {
    return res.status(403).json({ erro: "Sem permissão para esta ação." });
  }

  next();
}

function requireDeletePermission(req, res, next) {
  const role = normalizeRole(req.user?.role);
  console.log("ROLE RECEBIDO:", role);

  if (!["gestor", "ti"].includes(role)) {
    return res.status(403).json({ erro: "Sem permissão para excluir registros." });
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


app.get("/machines", authenticate, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name AS nome, category AS categoria
       FROM machines
       ORDER BY CASE category WHEN 'Primária' THEN 1 WHEN 'Secundária' THEN 2 ELSE 3 END, name ASC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Erro no GET /machines:", error);
    res.status(500).json({ erro: error.message || "Erro ao buscar máquinas." });
  }
});

app.post("/machines", authenticate, async (req, res) => {
  try {
    const name = String(req.body?.nome || req.body?.name || "").trim();
    const category = String(req.body?.categoria || req.body?.category || "Cadastrada").trim() || "Cadastrada";
    if (!name) return res.status(400).json({ erro: "Nome da máquina é obrigatório." });
    const item = await upsertMachine(name, category);
    res.status(201).json({ id: item.id, nome: item.name, categoria: item.category });
  } catch (error) {
    console.error("Erro no POST /machines:", error);
    res.status(500).json({ erro: error.message || "Erro ao cadastrar máquina." });
  }
});

app.get("/products", authenticate, async (req, res) => {
  try {
    const machine = String(req.query.machine || "").trim();
    const values = [];
    let where = "";
    if (machine) {
      values.push(machine);
      where = "WHERE machine = $1 OR machine IS NULL";
    }
    const result = await pool.query(
      `SELECT id, name AS nome, machine AS maquina
       FROM products
       ${where}
       ORDER BY name ASC`,
      values
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Erro no GET /products:", error);
    res.status(500).json({ erro: error.message || "Erro ao buscar produtos." });
  }
});

app.post("/products", authenticate, async (req, res) => {
  try {
    const name = String(req.body?.nome || req.body?.name || "").trim();
    const machine = String(req.body?.maquina || req.body?.machine || "").trim();
    if (!name) return res.status(400).json({ erro: "Nome do produto é obrigatório." });
    const item = await upsertProduct(name, machine || null);
    res.status(201).json({ id: item.id, nome: item.name, maquina: item.machine });
  } catch (error) {
    console.error("Erro no POST /products:", error);
    res.status(500).json({ erro: error.message || "Erro ao cadastrar produto." });
  }
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
    res.status(500).json({ erro: error.message || "Erro ao buscar falhas." });
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

    await upsertMachine(maquina, "Cadastrada");
    await upsertProduct(produto, maquina);

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
    res.status(500).json({ erro: error.message || "Erro ao salvar falha." });
  }
});

app.put("/failures/:id/resolve", authenticate, requireResolvePermission, async (req, res) => {
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
    res.status(500).json({ erro: error.message || "Erro ao resolver falha." });
  }
});

app.get("/failures/similar", authenticate, async (req, res) => {
  try {
    const machine = String(req.query.machine || "").trim();
    const product = String(req.query.product || "").trim();
    const problem = String(req.query.problem || "").trim();
    const cause = String(req.query.cause || "").trim();

    const normMachine = normalizeText(machine);
    const normProduct = normalizeText(product);
    const normProblem = normalizeText(problem);
    const normCause = normalizeText(cause);

    // Não pesquisar só por produto/máquina. Isso gerava sugestão para quase tudo.
    // Exige uma pista técnica mínima: problema ou causa com texto útil.
    if (normProblem.length < 5 && normCause.length < 5) {
      return res.json([]);
    }

    const queryTokens = [...expandKeywords(`${problem} ${cause}`)]
      .filter((token) => token.length >= 4 && !["falha", "erro", "problema", "maquina", "produto"].includes(token));

    if (queryTokens.length === 0 && normProblem.length < 8 && normCause.length < 8) {
      return res.json([]);
    }

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
       WHERE COALESCE(solution, '') <> ''
       ORDER BY created_at DESC
       LIMIT 300`
    );

    const scored = result.rows
      .map((row) => {
        let score = 0;
        let technicalHits = 0;

        const rowMachine = normalizeText(row.maquina);
        const rowProduct = normalizeText(row.produto);
        const rowProblem = normalizeText(row.problema);
        const rowCause = normalizeText(row.causa);
        const rowSolution = normalizeText(row.solucao);

        if (normProblem.length >= 5 && (rowProblem.includes(normProblem) || normProblem.includes(rowProblem))) {
          score += 10;
          technicalHits += 2;
        }

        if (normCause.length >= 5 && (rowCause.includes(normCause) || normCause.includes(rowCause))) {
          score += 7;
          technicalHits += 2;
        }

        for (const token of queryTokens) {
          let hit = false;
          if (rowProblem.includes(token)) { score += 4; hit = true; }
          if (rowCause.includes(token)) { score += 3; hit = true; }
          if (rowSolution.includes(token)) { score += 2; hit = true; }
          if (hit) technicalHits += 1;
        }

        // Máquina e produto apenas refinam o ranking. Não autorizam sugestão sozinhos.
        if (normMachine && rowMachine === normMachine) score += 2;
        if (normProduct && rowProduct && (rowProduct.includes(normProduct) || normProduct.includes(rowProduct))) score += 2;
        if (row.status === "resolvida") score += 2;

        return { ...row, score, technicalHits };
      })
      .filter((row) => row.technicalHits >= 1 && row.score >= 7)
      .sort((a, b) => b.score - a.score || new Date(b.dataHora).getTime() - new Date(a.dataHora).getTime())
      .slice(0, 5)
      .map(({ technicalHits, ...row }) => row);

    res.json(scored);
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

app.delete("/failures/:id", authenticate, requireDeletePermission, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM failures WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (error) {
    console.error("Erro no DELETE /failures/:id:", error);
    res.status(500).json({ erro: error.message || "Erro ao excluir falha." });
  }
});

const port = Number(process.env.APP_PORT || 3000);

app.listen(port, "0.0.0.0", async () => {
  console.log(`Servidor rodando na porta ${port}`);
  console.log("Servidor acessível na rede local.");
  await initDatabase();
});
