const admin = require("firebase-admin");

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
function fail(statusCode, stage, message) {
  console.error("[send-order-email]", stage, message);
  return response(statusCode, { ok: false, stage, error: message });
}
function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

exports.handler = async event => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return fail(405, "method", "Method not allowed.");

  let stage = "request";
  try {
    stage = "authorization";
    const authHeader = event.headers?.authorization || event.headers?.Authorization || "";
    const match = String(authHeader).match(/^Bearer\s+(.+)$/i);
    if (!match) return fail(401, stage, "No Firebase sign-in token was received.");

    stage = "firebase-admin-init";
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) return fail(503, stage, "FIREBASE_SERVICE_ACCOUNT_JSON is missing from the function runtime.");
    let serviceAccount;
    try { serviceAccount = JSON.parse(raw); }
    catch { return fail(503, stage, "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON."); }
    const app = admin.apps.length ? admin.app() : admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

    stage = "firebase-token-verification";
    let decoded;
    try { decoded = await admin.auth(app).verifyIdToken(match[1]); }
    catch (e) { return fail(401, stage, "Firebase rejected the customer sign-in token: " + String(e.message || e).slice(0,180)); }

    stage = "firestore-init";
    const db = admin.firestore(app);

    stage = "request-body";
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return fail(400, stage, "Request body is not valid JSON."); }
    const orderId = String(body.orderId || "");
    if (!/^[A-Za-z0-9_-]{10,150}$/.test(orderId)) return fail(400, stage, "Order reference is missing or invalid.");

    stage = "firestore-order-read";
    const orderRef = db.collection("confirmedOrders").doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) return fail(404, stage, "The order was not found in confirmedOrders.");

    const order = orderSnap.data();
    stage = "order-ownership";
    if (order.customerUid !== decoded.uid) return fail(403, stage, "The signed-in customer does not own this order.");

    stage = "resend-api-key";
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return fail(503, stage, "RESEND_API_KEY is missing from the function runtime.");

    const recipient = "Juliusafrifa5@gmail.com";
    const eventRef = db.collection("orderEmailEvents").doc(orderId);
    stage = "firestore-event-read";
    const alreadySent = await eventRef.get();
    if (alreadySent.exists && alreadySent.data().adminEmailStatus === "sent") {
      return response(200, { ok: true, alreadySent: true, stage: "already-sent" });
    }

    stage = "firestore-event-write";
    await eventRef.set({
      orderId, orderNo: String(order.orderNo || orderId), customerUid: decoded.uid,
      adminEmailStatus: "sending", diagnosticVersion: 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    stage = "email-build";
    const items = Array.isArray(order.items) ? order.items : [];
    const itemRows = items.map(item =>
      `<tr><td style="padding:8px;border-bottom:1px solid #eee">${safe(item.name)}</td>` +
      `<td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${Number(item.quantity || 0)}</td>` +
      `<td style="padding:8px;border-bottom:1px solid #eee;text-align:right">GH₵${Number(item.lineTotal || 0).toFixed(2)}</td></tr>`
    ).join("");
    const delivery = order.delivery || {};
    const html = `<div style="font-family:Arial,sans-serif;max-width:650px;margin:auto;color:#292929">
      <h2 style="color:#e87500">Mary Cereal Mix — New Order</h2><p>A new order has been placed.</p>
      <p><b>Order:</b> ${safe(order.orderNo || orderId)}<br><b>Customer:</b> ${safe(order.customerName)}<br>
      <b>Email:</b> ${safe(order.customerEmail)}<br><b>Phone:</b> ${safe(order.customerPhone)}<br>
      <b>Delivery:</b> ${safe([delivery.address,delivery.town,delivery.district,delivery.region].filter(Boolean).join(", ") || order.deliveryMethod || "Not specified")}<br>
      <b>Payment:</b> ${safe(order.paymentMethod || "—")}</p>
      <table style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left;padding:8px">Item</th><th>Qty</th><th style="text-align:right">Amount</th></tr></thead>
      <tbody>${itemRows}</tbody></table><p style="text-align:right;font-size:18px"><b>Total: GH₵${Number(order.total || 0).toFixed(2)}</b></p>
      <p style="color:#777;font-size:12px">Test notification sent through Resend.</p></div>`;

    stage = "resend-api-request";
    let send;
    try {
      send = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Mary Cereal Mix <onboarding@resend.dev>",
          to: [recipient],
          subject: `New order ${String(order.orderNo || orderId)} — Mary Cereal Mix`,
          html
        })
      });
    } catch (e) {
      await eventRef.set({ adminEmailStatus:"failed", diagnosticStage:stage, error:String(e.message || e).slice(0,250), updatedAt:admin.firestore.FieldValue.serverTimestamp() }, {merge:true});
      return fail(502, stage, "Network request to Resend failed: " + String(e.message || e).slice(0,180));
    }

    stage = "resend-response";
    const result = await send.json().catch(() => ({}));
    if (!send.ok) {
      const detail = String(result.message || result.name || "Resend rejected the email").slice(0,250);
      await eventRef.set({ adminEmailStatus:"failed", diagnosticStage:stage, error:detail, updatedAt:admin.firestore.FieldValue.serverTimestamp() }, {merge:true});
      return fail(502, stage, detail);
    }

    stage = "firestore-final-write";
    await eventRef.set({
      adminEmailStatus:"sent", resendEmailId:result.id || "", sentTo:recipient,
      sentAt:admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:admin.firestore.FieldValue.serverTimestamp()
    }, {merge:true});
    return response(200, {ok:true, sentTo:recipient, stage:"sent"});
  } catch (error) {
    return fail(500, stage, String(error.message || error).slice(0,250));
  }
};
