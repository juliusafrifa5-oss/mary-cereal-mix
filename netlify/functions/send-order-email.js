const admin = require("firebase-admin");

function getApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Firebase server configuration is missing.");
  return admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw))
  });
}

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "https://mary-cereal-mix.netlify.app",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function response(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

exports.handler = async event => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return response(405, { ok: false, error: "Method not allowed." });

  try {
    const match = String(event.headers?.authorization || event.headers?.Authorization || "")
      .match(/^Bearer\s+(.+)$/i);
    if (!match) return response(401, { ok: false, error: "Please sign in again." });

    const app = getApp();
    const decoded = await admin.auth(app).verifyIdToken(match[1]);
    const db = admin.firestore(app);

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return response(400, { ok: false, error: "Invalid request." }); }

    const orderId = String(body.orderId || "");
    if (!/^[A-Za-z0-9_-]{10,150}$/.test(orderId)) {
      return response(400, { ok: false, error: "Invalid order reference." });
    }

    const orderRef = db.collection("confirmedOrders").doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) return response(404, { ok: false, error: "Order not found." });

    const order = orderSnap.data();
    if (order.customerUid !== decoded.uid) {
      return response(403, { ok: false, error: "You cannot request an email for this order." });
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return response(503, { ok: false, error: "Email service is not configured." });

    // The Resend test sender can only deliver to the account's verified email.
    const recipient = "Juliusafrifa5@gmail.com";
    const eventRef = db.collection("orderEmailEvents").doc(orderId);
    const alreadySent = await eventRef.get();
    if (alreadySent.exists && alreadySent.data().adminEmailStatus === "sent") {
      return response(200, { ok: true, alreadySent: true });
    }

    await eventRef.set({
      orderId,
      orderNo: String(order.orderNo || orderId),
      customerUid: decoded.uid,
      adminEmailStatus: "sending",
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    const items = Array.isArray(order.items) ? order.items : [];
    const itemRows = items.map(item =>
      `<tr><td style="padding:8px;border-bottom:1px solid #eee">${safe(item.name)}</td>` +
      `<td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${Number(item.quantity || 0)}</td>` +
      `<td style="padding:8px;border-bottom:1px solid #eee;text-align:right">GH₵${Number(item.lineTotal || 0).toFixed(2)}</td></tr>`
    ).join("");

    const delivery = order.delivery || {};
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:650px;margin:auto;color:#292929">
        <h2 style="color:#e87500">Mary Cereal Mix — New Order</h2>
        <p>A new order has been placed.</p>
        <p><b>Order:</b> ${safe(order.orderNo || orderId)}<br>
        <b>Customer:</b> ${safe(order.customerName)}<br>
        <b>Email:</b> ${safe(order.customerEmail)}<br>
        <b>Phone:</b> ${safe(order.customerPhone)}<br>
        <b>Delivery:</b> ${safe([delivery.address, delivery.town, delivery.district, delivery.region].filter(Boolean).join(", ") || order.deliveryMethod || "Not specified")}<br>
        <b>Payment:</b> ${safe(order.paymentMethod || "—")}</p>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr><th style="text-align:left;padding:8px">Item</th><th>Qty</th><th style="text-align:right">Amount</th></tr></thead>
          <tbody>${itemRows}</tbody>
        </table>
        <p style="text-align:right;font-size:18px"><b>Total: GH₵${Number(order.total || 0).toFixed(2)}</b></p>
        <p style="color:#777;font-size:12px">This is a test notification sent through Resend.</p>
      </div>`;

    const send = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Mary Cereal Mix <onboarding@resend.dev>",
        to: [recipient],
        subject: `New order ${String(order.orderNo || orderId)} — Mary Cereal Mix`,
        html
      })
    });

    const result = await send.json().catch(() => ({}));
    if (!send.ok) {
      await eventRef.set({
        adminEmailStatus: "failed",
        error: String(result.message || result.name || "Resend rejected the email").slice(0, 300),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      console.error("Resend rejected order email:", result);
      return response(502, { ok: false, error: "Resend could not send the test email." });
    }

    await eventRef.set({
      adminEmailStatus: "sent",
      resendEmailId: result.id || "",
      sentTo: recipient,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return response(200, { ok: true, sentTo: recipient });
  } catch (error) {
    console.error("Order email function failed:", error);
    return response(500, { ok: false, error: "Unable to send the order email." });
  }
};
