import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import falhaRoutes from "./routes/falhaRoutes.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("API Coletor de Falhas rodando 🚀");
});

app.use("/falhas", falhaRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
