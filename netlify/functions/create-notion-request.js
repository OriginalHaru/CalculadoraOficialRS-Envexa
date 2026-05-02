const { Client } = require("@notionhq/client");
const { Resend } = require("resend");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { customer, shipping, boxes, totals, compliance_warnings, pdfBase64 } = body;

  if (!customer?.name || !customer?.email) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing required customer fields" }) };
  }

  try {
    // ── 1. Crear página en Notion ───────────────────────────────────────────
    const notion = new Client({ auth: process.env.NOTION_TOKEN });

    const rangeText = `USD ${totals?.total_usd_min?.toFixed(2)} – ${totals?.total_usd_max?.toFixed(2)}`;

    const page = await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties: {
        // TODO: confirmar los nombres exactos de las propiedades de tu DB de Notion
        "Nombre": {
          title: [{ text: { content: customer.name } }]
        },
        "Email": {
          email: customer.email
        },
        "Teléfono": {
          phone_number: customer.phone || ""
        },
        "CUIT": {
          rich_text: [{ text: { content: customer.cuit || "" } }]
        },
        "Dirección": {
          rich_text: [{ text: { content: customer.address || "" } }]
        },
        "Courier": {
          select: { name: shipping?.courier || "No especificado" }
        },
        "FOB Total (USD)": {
          number: totals?.fob_total_usd || 0
        },
        "Total Estimado Min (USD)": {
          number: totals?.total_usd_min || 0
        },
        "Total Estimado Max (USD)": {
          number: totals?.total_usd_max || 0
        },
        "Peso Cobrable (kg)": {
          number: boxes?.reduce((s, b) => s + (b.weight_chargeable_kg || 0), 0) || 0
        },
        "Estado": {
          select: { name: "Solicitud Nueva" }
        },
      },
    });

    // ── 2. Agregar bloque de detalle como comentario en la página ───────────
    const detailLines = [
      `Courier: ${shipping?.courier}`,
      `Flete estimado: USD ${totals?.freight_min_usd?.toFixed(2)} – ${totals?.freight_max_usd?.toFixed(2)}`,
      `Seguro: USD ${totals?.insurance_usd?.toFixed(2)}`,
      `DAI 35%: USD ${totals?.duties_min_usd?.toFixed(2)} – ${totals?.duties_max_usd?.toFixed(2)}`,
      `Tasa Est. 3%: USD ${totals?.tasa_est_min_usd?.toFixed(2)} – ${totals?.tasa_est_max_usd?.toFixed(2)}`,
      `IVA 21%: USD ${totals?.iva_min_usd?.toFixed(2)} – ${totals?.iva_max_usd?.toFixed(2)}`,
      `Gastos doc.: USD ${totals?.documental_costs_usd?.toFixed(2)}`,
      `Gastos destino: USD ${totals?.destination_costs_usd?.toFixed(2)}`,
      `Gestión ENVEXA: USD ${totals?.envexa_fee_usd?.toFixed(2)}`,
      `TOTAL: ${rangeText}`,
      `TC USD oficial: $${totals?.exchange_rate_ars?.toFixed(2)} ARS`,
      ``,
      `Alertas de compliance: ${compliance_warnings?.length ? compliance_warnings.map(w => w.msg).join(" | ") : "Ninguna"}`,
      ``,
      `Cajas (${boxes?.length}):`,
      ...(boxes || []).flatMap(b => [
        `  ${b.name}: ${b.weight_kg}kg real, ${b.weight_chargeable_kg?.toFixed(2)}kg cobrable`,
        ...(b.products || []).map(p =>
          `    - ${p.name || "?"} x${p.qty} | FOB: USD ${p.fob_unit_usd} /u | HS: ${p.hs_code || "—"}`
        ),
      ]),
    ].join("\n");

    await notion.comments.create({
      parent: { page_id: page.id },
      rich_text: [{ text: { content: detailLines.substring(0, 2000) } }],
    });

    // ── 3. Enviar email con PDF adjunto vía Resend ──────────────────────────
    const resend = new Resend(process.env.RESEND_API_KEY);
    const base64Data = (pdfBase64 || "").replace(/^data:application\/pdf;base64,/, "");

    const emailRecipients = [customer.email];
    if (process.env.ENVEXA_INTERNAL_EMAIL) {
      emailRecipients.push(process.env.ENVEXA_INTERNAL_EMAIL);
    }

    const boxesSummary = (boxes || [])
      .map(b => `• ${b.name}: ${b.products?.map(p => `${p.name} x${p.qty}`).join(", ")}`)
      .join("\n");

    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: emailRecipients,
      subject: `Nueva solicitud de cotización ENVEXA — ${customer.name}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #0b1f3a; padding: 24px; border-radius: 12px 12px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 20px;">ENVEXA · Cotización de Importación</h1>
            <p style="color: #93c5fd; margin: 4px 0 0; font-size: 14px;">Régimen Simplificado · Aéreo China → Argentina</p>
          </div>
          <div style="background: #f8fafc; padding: 24px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0;">
            <p style="color: #374151; font-size: 15px;">Hola <strong>${customer.name}</strong>,</p>
            <p style="color: #374151; font-size: 14px; line-height: 1.6;">
              Adjuntamos el estimado de tu importación. Un asesor de <strong>ENVEXA</strong> se contactará en breve para confirmar el presupuesto final.
            </p>
            <div style="background: white; border-radius: 8px; padding: 16px; margin: 16px 0; border: 1px solid #e2e8f0;">
              <p style="font-size: 13px; color: #6b7280; margin: 0 0 8px;">RESUMEN</p>
              <table style="width:100%; font-size:14px; border-collapse:collapse;">
                <tr><td style="padding:4px 0; color:#6b7280;">Courier</td><td style="text-align:right; font-weight:600;">${shipping?.courier}</td></tr>
                <tr><td style="padding:4px 0; color:#6b7280;">FOB total</td><td style="text-align:right;">USD ${totals?.fob_total_usd?.toFixed(2)}</td></tr>
                <tr><td style="padding:4px 0; color:#6b7280;">Peso cobrable</td><td style="text-align:right;">${boxes?.reduce((s,b)=>s+(b.weight_chargeable_kg||0),0)?.toFixed(2)} kg</td></tr>
                <tr style="border-top:2px solid #e2e8f0;">
                  <td style="padding:8px 0 4px; font-weight:700; color:#111827;">TOTAL ESTIMADO</td>
                  <td style="text-align:right; font-weight:700; color:#16a34a; font-size:16px;">${rangeText}</td>
                </tr>
              </table>
            </div>
            <p style="color:#374151; font-size:13px;"><strong>Productos incluidos:</strong></p>
            <pre style="font-size:12px; color:#6b7280; background:#f1f5f9; padding:12px; border-radius:6px; white-space:pre-wrap;">${boxesSummary}</pre>
            <p style="color:#9ca3af; font-size:11px; margin-top:16px; line-height:1.5;">
              <em>Los valores son estimativos. El costo final puede variar según el tipo de cambio oficial vigente al momento del despacho. TC usado: $${totals?.exchange_rate_ars?.toFixed(2)} ARS/USD.</em>
            </p>
            <hr style="border:none; border-top:1px solid #e2e8f0; margin:20px 0;">
            <p style="color:#6b7280; font-size:12px;">
              📧 ${customer.email} &nbsp;|&nbsp; 📞 ${customer.phone || "—"} &nbsp;|&nbsp; CUIT: ${customer.cuit || "—"}
            </p>
          </div>
        </div>
      `,
      attachments: base64Data
        ? [{ filename: `cotizacion-envexa-${customer.name.replace(/\s+/g, "-").toLowerCase()}.pdf`, content: base64Data }]
        : [],
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ ok: true, pageId: page.id }),
    };

  } catch (err) {
    console.error("Error creating request:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
