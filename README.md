# Backend do Coletor de Falhas

## 1. Instalar dependências
```bash
npm install
```

## 2. Configurar o .env
Edite o arquivo `.env` e defina:
- credenciais do PostgreSQL
- `API_AUTH_USER`
- `API_AUTH_PASS`

## 3. Criar a tabela
```bash
psql -U postgres -d coletor_falhas -f schema.sql
```

## 4. Subir o servidor
```bash
npm run dev
```

## 5. Testes
Rota pública:
```bash
curl http://SEU_IP:3000/
```

Rota protegida:
```bash
curl -u admin:123456 http://SEU_IP:3000/failures
```
