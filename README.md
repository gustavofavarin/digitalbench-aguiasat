# Consulta Rastreador Getrak

App de tela única para consultar a posição atual de um equipamento no Getrak a
partir do **ID/IMEI** (típico fluxo de validação de instalação por técnico).

## Como funciona

- **Frontend (React + Vite)**: tela única com input de busca e cards de
  resultado. Cada card mostra ID, placa, última atualização, localização
  (endereço resolvido por reverse geocoding) e voltagem.
- **Backend (Node + Express)**: encapsula as credenciais da Getrak, faz o
  fluxo OAuth `password`, mantém o token em cache (renovação automática) e
  expõe `/api/search` para o frontend.

### Por que existe um cache de snapshot no servidor

O scope `PublicoCliente` do usuário `int@aguiasat` **não** dá acesso ao
endpoint `/v0.2/equipamentos/integracao` (401). O único endpoint disponível
para essa conta é `GET /v0.1/localizacoes`, que **não aceita filtro por IMEI
no servidor**. Por isso o backend baixa todas as páginas
(`per_page=500`, ~28 chamadas) uma vez no startup e mantém o snapshot em
memória, refrescando a cada 5 minutos. As buscas são feitas em memória, então
são imediatas.

O reverse geocoding usa o [Nominatim](https://nominatim.openstreetmap.org/)
(OSM) com cache em memória dos resultados.

## Setup

```bash
npm install
cp .env.example .env   # edite se precisar trocar credenciais
```

## Rodar em desenvolvimento

```bash
npm run dev
```

Sobe os dois processos em paralelo:

- Backend em http://localhost:3001
- Frontend em http://localhost:5173 (Vite, com proxy `/api` → backend)

Abra http://localhost:5173.

> **Primeira carga**: o backend leva ~20s no startup para baixar todas as
> ~14k localizações. Enquanto isso, a primeira busca espera o snapshot
> terminar.

## Build de produção

```bash
npm run build       # gera dist/ (frontend)
npm start           # roda o backend
```

Em produção, sirva o `dist/` em um proxy reverso (Nginx, Caddy) que também
encaminhe `/api/*` para `http://localhost:3001`.

## Variáveis de ambiente (`.env`)

| Variável          | Descrição                                    |
| ----------------- | -------------------------------------------- |
| `GETRAK_API_KEY`  | Chave (Basic, base64) fornecida pela Getrak  |
| `GETRAK_USERNAME` | Usuário do fluxo OAuth password              |
| `GETRAK_PASSWORD` | Senha do fluxo OAuth password                |
| `PORT`            | Porta do backend (padrão 3001)               |

## API

### `GET /api/search?q=<termo>`

Filtra o snapshot por dígitos do IMEI (`modulo`). Aceita os últimos 6
dígitos (padrão do uso da equipe) ou o IMEI completo.

Resposta:

```json
{
  "results": [
    {
      "id": "355322092645117",
      "modulo": "ID355322092645117",
      "placa": "ABC1D23",
      "apelido": "ABC1D23",
      "idVeiculo": 1234567,
      "ultimaAtualizacao": "2026-05-19T11:04:39.000Z",
      "localizacao": "Rua João Ziomek, Araucária - PR, 83709, Brasil",
      "voltagem": 13.53,
      "lat": -25.59,
      "lon": -49.41,
      "statusOnline": 1
    }
  ],
  "total": 1,
  "truncated": false,
  "snapshotUpdatedAt": "2026-05-19T11:00:00.000Z"
}
```

Use `?force=1` para forçar refresh do snapshot.

### `GET /api/health`

`{ ok: true, snapshot: { total, updatedAt } }`

## Estrutura

```
server/
  index.js     Express + /api/search + /api/health
  getrak.js    OAuth + snapshot cache + busca em memória
  geocode.js   Nominatim + cache LRU simples
src/
  App.tsx      Tela única
  App.css
  index.css
  main.tsx
```
