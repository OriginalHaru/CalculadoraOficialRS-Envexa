# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A client-facing, single-page import auto-quote calculator for **ENVEXA** (Argentina). Customers fill in shipment details (China → Argentina, air freight, Régimen Simplificado), see a live cost estimate, and submit a quote request that creates a Notion page and sends a PDF by email.

## Stack

- **Frontend:** Single `index.html` — vanilla JS, Tailwind CDN (dark mode via `darkMode: 'class'`), jsPDF CDN. No build step. Open directly in browser.
- **Backend:** One Netlify Function (`netlify/functions/create-notion-request.js`) using `@notionhq/client` and `resend`.
- **Hosting:** Netlify (static site + functions).

## Local development

```bash
# Install function dependencies
npm install

# Run locally with the Netlify CLI (required to test the function)
npx netlify dev
```

The frontend alone (without the function) can be opened directly in a browser — all live recalculation works offline. The submit button will fail without `netlify dev` running.

Required env vars (set in `.env` for local, Netlify dashboard for production):
- `NOTION_TOKEN`
- `NOTION_DATABASE_ID`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `ENVEXA_INTERNAL_EMAIL` (optional — receives a BCC copy of every email)

## Architecture

### Frontend (`index.html`)

All logic lives in a single `<script>` block. Key flow:

1. **`fetchExchangeRate()`** — fetches `dolarapi.com/v1/dolares/oficial` on load, stores in `exchangeRate`. Fallback: 1200 ARS/USD.
2. **`addBox()` / `addProduct(boxId)`** — dynamically append DOM nodes for boxes and product rows. Each input fires `recalc()`.
3. **`recalc()`** — orchestrator: calls `getBoxes()` → `calcTotals()` → `checkCompliance()` → `renderBoxSummaries()` → `renderCompliance()` → `renderSummary()`.
4. **`submitRequest()`** — validates, calls `generatePdf()`, POSTs to `/.netlify/functions/create-notion-request`.

**Key constants (do not change without updating the PRD):**
```js
const FREIGHT_TIERS = [
  { max_kg: 100,      price_per_kg: 15 },
  { max_kg: 200,      price_per_kg: 14 },
  { max_kg: Infinity, price_per_kg: 13 },
];
const ENVEXA_FEE_USD = 150;   // fixed management fee
const DOCUMENTAL_FEE = 29;    // charged if pesoCob > 90kg OR FOB > USD 700
const VOL_DIV = 6000;         // volumetric divisor (client-facing; internal calc uses 5000)
```

**Tax formula (fixed, not user-editable):**
```
CIF = FOB + flete + seguro (1% FOB)
derechos = CIF × 0.35
tasa_est = (CIF + derechos) × 0.03
iva = (CIF + derechos + tasa_est) × 0.21
comision_bancaria = flete × 0.02
total = CIF + derechos + tasa_est + iva + gastos_doc + gastos_destino (85) + gestion_envexa + comision_bancaria
```

### Netlify Function (`netlify/functions/create-notion-request.js`)

Receives the full payload from the frontend and:
1. Creates a page in the Notion DB with customer + cost properties.
2. Appends a comment to that page with full cost/box detail (Notion doesn't support base64 file upload).
3. Sends an HTML email via Resend with the PDF attached to `customer.email` + optionally `ENVEXA_INTERNAL_EMAIL`.

**Notion property names are hardcoded** — if the DB schema changes, update the `properties` object in this file. Current assumed names: `Nombre` (title), `Email`, `Teléfono`, `CUIT`, `Dirección`, `Courier` (select), `FOB Total (USD)`, `Total Estimado Min (USD)`, `Total Estimado Max (USD)`, `Peso Cobrable (kg)`, `Estado` (select, default "Solicitud Nueva").

### Payload shape (frontend → function)

```json
{
  "customer": { "name", "email", "phone", "cuit", "address" },
  "shipping": { "courier", "freight_rate_usd_per_kg" },
  "boxes": [{ "name", "weight_kg", "L_cm", "W_cm", "H_cm", "weight_volumetric_kg", "weight_chargeable_kg",
    "products": [{ "name", "qty", "weight_unit_kg", "fob_unit_usd", "hs_code", "fob_total_usd" }] }],
  "totals": { "fob_total_usd", "freight_usd", "freight_rate_per_kg", "insurance_usd",
    "duties_usd", "tasa_est_usd", "iva_usd", "documental_costs_usd", "destination_costs_usd",
    "envexa_fee_usd", "banking_fee_usd", "total_usd", "total_ars", "exchange_rate_ars" },
  "canal_especial": false,
  "compliance_warnings": [],
  "attachments": [{ "filename", "content_base64", "mime_type", "size_bytes" }],
  "pdfBase64": "data:application/pdf;base64,..."
}
```

## Compliance alerts

Triggered automatically in `checkCompliance()`:
- FOB unit > USD 200
- FOB total > USD 1000
- Peso real total > 150 kg
- HS code starts with: `8471`, `8517`, `8542`, `9013`, `9014`, `8543`, `8803`, `8802`, `8525`, `8528`
- Box with no products

## File upload constraints

Max 5 files, 10 MB each. Accepted: `.pdf`, `.jpg`, `.jpeg`, `.png`, `.xlsx`, `.xls`, `.doc`, `.docx`. Files are base64-encoded client-side and sent in the payload. **Netlify Functions have a 6 MB payload limit** — if exceeded, the function returns a 413 and the frontend should surface an error.
