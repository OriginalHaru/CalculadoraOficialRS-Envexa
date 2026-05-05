const { Client } = require("@notionhq/client");
const nodemailer = require("nodemailer");

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

  const { customer, shipping, boxes, totals, compliance_warnings, pdfBase64, country } = body;
  const countryLabel = country === 'UY' ? 'Uruguay' : 'Argentina';
  const destFlag = country === 'UY' ? '🇺🇾' : '🇦🇷';

  if (!customer?.name || !customer?.email) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing required customer fields" }) };
  }

  const n = (v) => (typeof v === "number" ? v.toFixed(2) : "—");

  try {
    // ── 1. Crear página en Notion ───────────────────────────────────────────
    const notion = new Client({ auth: process.env.NOTION_TOKEN });


    const page = await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties: {
        "Cliente": {
          title: [{ text: { content: `⭐ ${customer.name}` } }]
        },
        "Correo Electronico": {
          email: customer.email
        },
        "Numero de Telefono": {
          phone_number: customer.phone || ""
        },
        "CUIT": {
          rich_text: [{ text: { content: customer.cuit || "" } }]
        },
        "Dirección de Entrega": {
          rich_text: [{ text: { content: customer.address || "" } }]
        },
        "Canal Especial?": {
          select: { name: body.canal_especial ? "SI" : "No" }
        },
        "Courier": {
          select: { name: shipping?.courier || "No especificado" }
        },
        "Status": {
          status: { name: "Solicitud Nueva" }
        },
        "Fecha de Solicitud": {
          date: { start: new Date().toISOString() }
        },
        "Peso Total": {
          number: totals?.weight_chargeable_kg || 0
        },
        "Precio x KG": {
          number: totals?.price_per_kg || 0
        },
        "Pais": {
          select: { name: countryLabel }
        },
      },
    });

    // ── 2. Agregar detalle financiero como bloques en la página ────────────
    const warningsText = (compliance_warnings?.length)
      ? compliance_warnings.join(" | ")
      : "Ninguna";

    const makeP = (text) => ({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: text.substring(0, 2000) } }] },
    });

    const boxBlocks = (boxes || []).flatMap(b => [
      makeP(`📦 ${b.name}: ${b.L_cm}×${b.W_cm}×${b.H_cm} cm | ${b.weight_kg}kg real / ${(b.weight_chargeable_kg||0).toFixed(2)}kg cobrable`),
      ...(b.products || []).map(p =>
        makeP(`   • ${p.name || "?"} x${p.qty} — FOB USD ${p.fob_unit_usd}/u${p.hs_code ? ` | HS: ${p.hs_code}` : ""}`)
      ),
    ]);

    await notion.blocks.children.append({
      block_id: page.id,
      children: [
        { object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "💰 Resumen financiero" } }] } },
        makeP(`Courier: ${shipping?.courier}`),
        makeP(`Flete aéreo: USD ${n(totals?.freight_usd)} (USD ${n(totals?.freight_rate_per_kg)}/kg)`),
        makeP(`Seguro: USD ${n(totals?.insurance_usd)}`),
        ...(country === 'UY' ? [
          makeP(`Arancel de importación 18% (s/CIF): USD ${n(totals?.duties_usd)}`),
          makeP(`Tasa aduanera 9% (s/CIF): USD ${n(totals?.tasa_est_usd)}`),
          makeP(`IVA importación 22% (s/CIF+arancel): USD ${n(totals?.iva_usd)}`),
          makeP(`Anticipo de IVA 10% (s/CIF+arancel): USD ${n(totals?.anticipo_iva_usd)}`),
        ] : [
          makeP(`DAI 35%: USD ${n(totals?.duties_usd)}`),
          makeP(`Tasa Est. 3%: USD ${n(totals?.tasa_est_usd)}`),
          makeP(`IVA 21%: USD ${n(totals?.iva_usd)}`),
        ]),
        makeP(`Gastos Despacho Exportación 🇨🇳: USD ${n(totals?.documental_costs_usd)}`),
        makeP(`Gastos Despacho Importación ${destFlag}: USD ${n(totals?.destination_costs_usd)}`),
        makeP(`Gestión ENVEXA: USD ${n(totals?.envexa_fee_usd)}`),
        makeP(`Comisión bancaria: USD ${n(totals?.banking_fee_usd)}`),
        makeP(`TOTAL: USD ${n(totals?.total_usd)} / ARS ${(totals?.total_ars||0).toFixed(0)}`),
        makeP(`Dólar crypto: $${n(totals?.exchange_rate_ars)} ARS/USD`),
        { object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "📦 Detalle de cajas" } }] } },
        ...boxBlocks,
        ...(compliance_warnings?.length ? [
          { object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "⚠️ Alertas" } }] } },
          ...compliance_warnings.map(w => ({
            object: "block",
            type: "bulleted_list_item",
            bulleted_list_item: { rich_text: [{ type: "text", text: { content: w } }] }
          }))
        ] : []),
      ],
    });

    // ── 3. Enviar email con PDF adjunto vía Hostinger SMTP ─────────────────
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.hostinger.com",
      port: parseInt(process.env.SMTP_PORT || "465"),
      secure: true,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    });

    const base64Data = (pdfBase64 || "").replace(/^data:application\/pdf;base64,/, "");

    const bcc = process.env.ENVEXA_INTERNAL_EMAIL || undefined;

    const boxesSummary = (boxes || [])
      .map(b => `• ${b.name}: ${b.products?.map(p => `${p.name} x${p.qty}`).join(", ")}`)
      .join("\n");

    const totalText = `USD ${n(totals?.total_usd)} / ARS ${(totals?.total_ars || 0).toLocaleString("es-AR", { maximumFractionDigits: 0 })}`;

    await transporter.sendMail({
      from: `ENVEXA <${process.env.SMTP_USER}>`,
      to: customer.email,
      bcc,
      subject: `Tu cotización de importación · ENVEXA`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #1c1c1c; padding: 24px; border-radius: 12px 12px 0 0;">
            <h1 style="color: #ffffff; margin: 0; font-size: 20px;">ENVEXA · Cotización de Importación</h1>
            <p style="color: #FECA0D; margin: 4px 0 0; font-size: 14px;">Régimen Simplificado · Aéreo China → ${countryLabel}</p>
          </div>
          <div style="background: #f8fafc; padding: 24px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0;">
            <p style="color: #374151; font-size: 15px;">Hola <strong>${customer.name}</strong>,</p>
            <p style="color: #374151; font-size: 14px; line-height: 1.6;">
              Recibimos tu solicitud. Adjuntamos el estimado de tu importación.
              Un asesor de <strong>ENVEXA</strong> se contactará en las próximas 24 hs hábiles para confirmar el costo final.
            </p>
            <div style="background: white; border-radius: 8px; padding: 16px; margin: 16px 0; border: 1px solid #e2e8f0;">
              <p style="font-size: 13px; color: #6b7280; margin: 0 0 12px; text-transform: uppercase; letter-spacing: 0.05em;">Resumen del envío</p>
              <table style="width:100%; font-size:14px; border-collapse:collapse;">
                <tr><td colspan="2" style="padding: 4px 0 2px; font-size:11px; color:#9ca3af; text-transform:uppercase; letter-spacing:0.05em; border-top: 1px solid #f1f5f9;">Datos</td></tr>
                <tr><td style="padding:4px 0; color:#6b7280;">Courier</td><td style="text-align:right; font-weight:600;">${shipping?.courier}</td></tr>
                <tr><td style="padding:4px 0; color:#6b7280;">Dirección de entrega</td><td style="text-align:right; font-size:13px;">${customer.address || "—"}</td></tr>

                <tr><td colspan="2" style="padding: 8px 0 2px; font-size:11px; color:#9ca3af; text-transform:uppercase; letter-spacing:0.05em; border-top: 1px solid #f1f5f9;">Costos</td></tr>
                <tr><td style="padding:4px 0; color:#6b7280;">FOB (mercadería)</td><td style="text-align:right;">USD ${n(totals?.fob_total_usd)}</td></tr>
                <tr><td style="padding:4px 0; color:#6b7280;">Flete aéreo</td><td style="text-align:right;">USD ${n(totals?.freight_usd)}</td></tr>
                <tr><td style="padding:4px 0; color:#6b7280;">Barreras arancelarias</td><td style="text-align:right;">USD ${n((totals?.duties_usd || 0) + (totals?.tasa_est_usd || 0) + (totals?.iva_usd || 0))}</td></tr>
                <tr><td style="padding:4px 0; color:#6b7280;">Costos fijos</td><td style="text-align:right;">USD ${n((totals?.documental_costs_usd || 0) + (totals?.destination_costs_usd || 0) + (totals?.envexa_fee_usd || 0) + (totals?.banking_fee_usd || 0))}</td></tr>

                <tr><td colspan="2" style="padding: 8px 0 2px; font-size:11px; color:#9ca3af; text-transform:uppercase; letter-spacing:0.05em; border-top: 1px solid #f1f5f9;">Logística</td></tr>
                <tr><td style="padding:4px 0; color:#6b7280;">Peso total cobrable</td><td style="text-align:right;">${n(totals?.weight_chargeable_kg)} kg</td></tr>
                <tr><td style="padding:4px 0; color:#6b7280;">Precio x kg</td><td style="text-align:right;">USD ${n(totals?.price_per_kg)}/kg</td></tr>

                <tr style="border-top: 2px solid #FECA0D;">
                  <td style="padding:10px 0 4px; font-weight:700; color:#1c1c1c; font-size:15px;">COSTO TOTAL</td>
                  <td style="text-align:right; font-weight:700; color:#1c1c1c; font-size:16px; background:#FECA0D; padding:6px 10px; border-radius:6px;">${totalText}</td>
                </tr>
              </table>
            </div>
            ${(() => {
              const mult = (totals?.fob_total_usd > 0) ? totals.total_usd / totals.fob_total_usd : 0;
              if (!mult) return '';
              const unitRows = (boxes || []).flatMap(b =>
                (b.products || [])
                  .filter(p => p.fob_unit_usd > 0)
                  .map(p => `<tr>
                    <td style="padding:4px 0; color:#374151;">${p.name || '?'} <span style="color:#9ca3af; font-size:12px;">×${p.qty}</span></td>
                    <td style="text-align:right; font-weight:600; color:#1c1c1c;">USD ${(p.fob_unit_usd * mult).toFixed(2)} / u</td>
                  </tr>`)
              ).join('');
              if (!unitRows) return '';
              return `
              <div style="background:white; border-radius:8px; padding:16px; margin:16px 0; border:1px solid #e2e8f0;">
                <p style="font-size:13px; color:#6b7280; margin:0 0 10px; text-transform:uppercase; letter-spacing:0.05em;">Precio unitario puesto en ${countryLabel}</p>
                <table style="width:100%; font-size:14px; border-collapse:collapse;">${unitRows}</table>
              </div>`;
            })()}
            <p style="color:#374151; font-size:13px;"><strong>Productos incluidos:</strong></p>
            <pre style="font-size:12px; color:#6b7280; background:#f1f5f9; padding:12px; border-radius:6px; white-space:pre-wrap;">${boxesSummary}</pre>
            <p style="color:#374151; font-size:13px; margin-top:16px;">
              Nuestro horario de atención es de lunes a viernes de 10:00 a 17:00 hs (hora Argentina).
            </p>
            <p style="color:#9ca3af; font-size:11px; margin-top:12px; line-height:1.5;">
              <em>Los valores son estimativos y no constituyen una oferta formal. El costo final puede variar según el tipo de cambio crypto vigente al momento del pago. Dólar crypto usado: $${n(totals?.exchange_rate_ars)} ARS/USD.</em>
            </p>
            <hr style="border:none; border-top:1px solid #e2e8f0; margin:20px 0;">
            <p style="color:#6b7280; font-size:12px;">
              📧 ${customer.email} &nbsp;|&nbsp; 📞 ${customer.phone || "—"} &nbsp;|&nbsp; CUIT: ${customer.cuit || "—"}
            </p>
          </div>
        </div>
      `,
      attachments: base64Data
        ? [{ filename: `cotizacion-envexa-${customer.name.replace(/\s+/g, "-").toLowerCase()}.pdf`, content: Buffer.from(base64Data, "base64") }]
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
