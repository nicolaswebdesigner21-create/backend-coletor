import pool from "../config/db.js";

export async function criarFalha(data) {
  const { descricao, maquina } = data;

  const result = await pool.query(
    "INSERT INTO falhas (descricao, maquina) VALUES ($1, $2) RETURNING *",
    [descricao, maquina]
  );

  return result.rows[0];
}

export async function listarFalhas() {
  const result = await pool.query("SELECT * FROM falhas ORDER BY id DESC");
  return result.rows;
}
