import * as service from "../services/falhaService.js";

export async function criar(req, res) {
  try {
    const falha = await service.criarFalha(req.body);
    res.status(201).json(falha);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

export async function listar(req, res) {
  try {
    const falhas = await service.listarFalhas();
    res.json(falhas);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}
