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

O scope `PublicoCliente` do usuário `<GETRAK_USERNAME>` **não** dá acesso ao
endpoint `/v0.2/equipamentos/integracao` (401). O único endpoint disponível
para essa conta é `GET /v0.1/localizacoes`, que **não aceita filtro por IMEI
no servidor**. Por isso o backend baixa todas as páginas
(`per_page=500`, ~28 chamadas) uma vez no startup e mantém o snapshot em
memória, refrescando a cada 5 minutos. As buscas são feitas em memória, então
são imediatas.

O reverse geocoding usa o [Nominatim](https://nominatim.openstreetmap.org/)
(OSM) com cache em memória dos resultados.

## Leitura de etiqueta por imagem

Para evitar digitar IMEI à mão a partir de uma foto recebida pelo
WhatsApp, o campo de busca aceita imagem por três caminhos:

- **Colar** uma imagem direto no campo (Ctrl+V / Cmd+V).
- **Arrastar e soltar** a foto sobre a barra de busca.
- Botão **📷** ao lado do campo (no celular abre a câmera traseira).

O OCR usa a **Google Cloud Vision API** (TEXT_DETECTION). A imagem é
redimensionada no browser (≤ 1600px, JPEG quality 0.85), enviada por
`POST /api/ocr` ao backend (Express em dev, Vercel Function em prod),
que repassa para a Vision com a `GOOGLE_VISION_API_KEY` configurada
no ambiente. O texto retornado é processado no cliente: ancora na
palavra "IMEI"/"UIN" da etiqueta, valida o IMEI com Luhn e preenche o
campo. Quando o IMEI bate completo (15 dígitos + Luhn), dispara
auto-busca em 3s. Leituras incompletas ou com aviso ficam aguardando
confirmação manual.

### Configuração da Vision API

1. Criar/entrar num projeto em https://console.cloud.google.com
2. Ativar **Cloud Vision API**
3. APIs & Services → Credentials → **Create API key**
4. Restringir a key:
   - **API restrictions**: apenas "Cloud Vision API"
   - **Application restrictions**: **None** — a chave é usada
     server-side (Express / Vercel Function), nunca chega ao browser.
     Restrições por HTTP referrer só funcionam pra chaves chamadas do
     browser e bloqueariam suas próprias chamadas legítimas.
5. Adicionar `GOOGLE_VISION_API_KEY` ao `.env` (dev) e Environment
   Variables do Vercel (prod, marcar **Sensitive**)
6. Configurar **Budget alert** em Billing → Budgets & alerts (ex:
   R$ 20/mês) — proteção extra contra surpresa.

**Custo**: 1.000 leituras/mês são grátis. Acima disso, US$ 1,50 por
1.000 imagens. Configure alertas de orçamento no GCP para evitar
surpresa.

### Dicas para uma foto que lê de primeira

- Aproxime a câmera o suficiente pra etiqueta preencher boa parte do
  quadro.
- Se possível, retire o plástico transparente que cobre a etiqueta —
  ele reflete e atrapalha o OCR.
- Iluminação difusa funciona melhor do que flash direto.

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

## Build de produção (servidor próprio)

```bash
npm run build       # gera dist/ (frontend)
npm start           # roda o backend
```

Em produção, sirva o `dist/` em um proxy reverso (Nginx, Caddy) que também
encaminhe `/api/*` para `http://localhost:3001`.

## Deploy na Vercel

O projeto também roda em serverless. O frontend é buildado pela Vercel
(`npm run build` → `dist/`) e cada arquivo em `api/` vira uma Vercel Function:

- `api/health.js` → `GET /api/health`
- `api/search.js` → `GET /api/search`

Os módulos em `server/` (`getrak.js`, `dotelematics.js`, `geocode.js`) são
reaproveitados como bibliotecas pelas functions. O Express em
`server/index.js` continua existindo só pro fluxo `npm run dev` local.

### Passos

1. **Configurar variáveis de ambiente** no dashboard da Vercel
   (Settings → Environment Variables), marcando Production, Preview e
   Development. As mesmas chaves do `.env.example`:
   `GETRAK_API_KEY`, `GETRAK_USERNAME`, `GETRAK_PASSWORD`,
   `DOTELEMATICS_APIKEY`, `DOTELEMATICS_USERNAME`,
   `DOTELEMATICS_PASSWORD`, `NOMINATIM_CONTACT`.
   **Não** prefixar com `VITE_` (caso contrário entrariam no bundle do
   browser).
2. **Deploy**: `vercel --prod` (ou push pra branch conectada).

### Diferenças em serverless

- **Sem preload de snapshot.** A primeira busca após um cold start dispara
  a carga do snapshot Getrak (~28 páginas) e a do realtime DO. Pode levar
  alguns segundos. Buscas seguintes usam o cache em memória da instância
  (5 min de TTL).
- **Cache de geocoding em memória apenas.** O filesystem é read-only —
  `geocode.js` detecta `process.env.VERCEL` e ignora a escrita em disco.
  Cada cold start recomeça do zero.
- **Timeout.** A busca tem `maxDuration: 60s` em [vercel.json](vercel.json)
  por causa do throttle do Nominatim (1 req/s × até 50 resultados).

## Variáveis de ambiente (`.env`)

| Variável                | Descrição                                         |
| ----------------------- | ------------------------------------------------- |
| `GETRAK_API_KEY`        | Chave (Basic, base64) fornecida pela Getrak       |
| `GETRAK_USERNAME`       | Usuário do fluxo OAuth password                   |
| `GETRAK_PASSWORD`       | Senha do fluxo OAuth password                     |
| `DOTELEMATICS_APIKEY`   | API key da DO Telematics                          |
| `DOTELEMATICS_USERNAME` | Login (email) DO Telematics                       |
| `DOTELEMATICS_PASSWORD` | Senha DO Telematics                               |
| `NOMINATIM_CONTACT`     | Email/URL para User-Agent do Nominatim            |
| `GOOGLE_VISION_API_KEY` | Chave da Google Cloud Vision (leitura por imagem) |
| `PORT`                  | Porta do backend dev (padrão 3001)                |

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
api/             Vercel Functions (produção em serverless)
  health.js
  search.js
  ocr.js
server/          Express (dev local) + bibliotecas compartilhadas
  index.js       Express + /api/search + /api/health + /api/ocr
  getrak.js     OAuth + snapshot cache + busca em memória
  dotelematics.js OAuth + realtime cache + busca
  geocode.js    Nominatim + cache (disco em dev, memória em serverless)
  vision.js     Cliente Google Cloud Vision (TEXT_DETECTION)
src/
  App.tsx       Tela única
  App.css
  index.css
  main.tsx
  components/
    ImeiCapture.tsx
  lib/
    imeiReader.ts  Resize + chamada /api/ocr + extração com âncora
vercel.json     Config das functions (maxDuration)
```
