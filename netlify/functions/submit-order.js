const admin = require("firebase-admin");

function app() {
  if (admin.apps.length) return admin.app();

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Server configuration is incomplete.");

  return admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw))
  });
}

const allowed = new Set([
  "https://mary-cereal-mix.netlify.app",
  "https://juliusafrifa5-oss.github.io",
  ...(process.env.ALLOWED_ORIGINS || "")
    .split(",").map(x => x.trim()).filter(Boolean)
]);

function out(status, body, origin) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Vary": "Origin"
  };

  if (origin && allowed.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Max-Age"] = "86400";
  }

  return { statusCode: status, headers, body: JSON.stringify(body) };
}

exports.handler = async event => {
  const origin = event.headers?.origin || event.headers?.Origin || "";

  // Browser preflight must be answered before auth or request-body processing.
  if (event.httpMethod === "OPTIONS") {
    if (!origin || !allowed.has(origin)) {
      return {
        statusCode: 403,
        headers: { "Cache-Control": "no-store", "Vary": "Origin" },
        body: ""
      };
    }

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Max-Age": "86400",
        "Cache-Control": "no-store",
        "Vary": "Origin"
      },
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return out(405, { ok: false, error: "Method not allowed." }, origin);
  }

  try {
    if (origin && !allowed.has(origin)) {
      return out(403, { ok: false, error: "Origin not allowed." }, origin);
    }

    const authHeader =
      event.headers?.authorization || event.headers?.Authorization || "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return out(401, { ok: false, error: "Please sign in again." }, origin);
    }

    const fb = app();
    const db = admin.firestore(fb);
    const token = await admin.auth(fb).verifyIdToken(match[1]);
    const uid = token.uid;

    let b;
    try {
      b = JSON.parse(event.body || "{}");
    } catch {
      return out(400, { ok: false, error: "Invalid order request." }, origin);
    }

    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 20) {
      return out(400, {
        ok: false,
        error: "Your cart is empty or contains too many products."
      }, origin);
    }

    const ps = await db.collection("users").doc(uid).get();
    if (!ps.exists || ps.data().role !== "customer" || ps.data().active === false) {
      return out(403, { ok: false, error: "This account cannot place orders." }, origin);
    }

    const profile = ps.data();
    const address = b.address || {};
    const name = String(address.name || profile.name || "").trim().slice(0, 120);
    const phone = String(address.phone || profile.phone || "").trim().slice(0, 40);
    const extra = String(address.extra || "").trim().slice(0, 500);

    if (!name || !phone) {
      return out(400, { ok: false, error: "Enter your name and contact number." }, origin);
    }

    const [regionSnap, districtSnap, townSnap] = await Promise.all([
      db.collection("deliveryRegions").doc(String(address.regionId || "")).get(),
      db.collection("deliveryDistricts").doc(String(address.districtId || "")).get(),
      db.collection("deliveryTowns").doc(String(address.townId || "")).get()
    ]);

    if (!regionSnap.exists || !districtSnap.exists || !townSnap.exists) {
      return out(400, { ok: false, error: "Your delivery address is incomplete." }, origin);
    }

    const region = regionSnap.data();
    const district = districtSnap.data();
    const town = townSnap.data();

    if (
      region.active === false || district.active === false || town.active === false ||
      district.regionId !== regionSnap.id || town.districtId !== districtSnap.id
    ) {
      return out(400, { ok: false, error: "The selected delivery area is unavailable." }, origin);
    }

    const seen = new Set();
    const items = [];

    for (const entry of b.items) {
      const id = String(entry.productId || "");
      const qty = Number(entry.quantity);

      if (!id || seen.has(id) || !Number.isSafeInteger(qty) || qty < 1 || qty > 1000) {
        return out(400, { ok: false, error: "One or more cart items are invalid." }, origin);
      }
      seen.add(id);

      const productSnap = await db.collection("products").doc(id).get();
      if (!productSnap.exists || productSnap.data().active === false) {
        return out(400, { ok: false, error: "A product in your cart is unavailable." }, origin);
      }

      const product = productSnap.data();
      const price = Number(product.retailPrice ?? product.price);

      if (!Number.isFinite(price) || price < 0) {
        return out(400, { ok: false, error: "A product price is not configured." }, origin);
      }

      // Reject missing, invalid, zero and insufficient stock.
      const stock = Number(product.stockQuantity);
      if (!Number.isSafeInteger(stock) || stock <= 0) {
        return out(409, {
          ok: false,
          error: String(product.name || "This product") + " is out of stock."
        }, origin);
      }
      if (qty > stock) {
        return out(409, {
          ok: false,
          error: "Only " + stock + " unit(s) are available for " +
            String(product.name || "this product") + "."
        }, origin);
      }

      items.push({
        productId: id,
        name: String(product.name || "Product"),
        unit: String(product.unit || "Pack"),
        quantity: qty,
        unitPrice: price,
        lineTotal: Number((price * qty).toFixed(2))
      });
    }

    const subtotal = Number(items.reduce((sum, item) => sum + item.lineTotal, 0).toFixed(2));
    const settingsSnap = await db.collection("appSettings").doc("checkout").get();
    const cfg = settingsSnap.exists ? settingsSnap.data() : {
      freeDelivery: false, discountActive: false, discountType: "percent", discountValue: 0
    };

    let discount = 0;
    if (cfg.discountActive === true) {
      const value = Math.max(0, Number(cfg.discountValue) || 0);
      discount = cfg.discountType === "fixed"
        ? Math.min(subtotal, value)
        : subtotal * Math.min(100, value) / 100;
    }
    discount = Number(discount.toFixed(2));

    const count = items.reduce((sum, item) => sum + item.quantity, 0);
    const multiplier = count >= 31 ? 5 : count >= 5 ? 2 : 1;
    const pickup = b.deliveryMethod === "pickup";
    const payment = b.paymentMethod === "cash" ? "cash" : "momo";
    let baseFee = 0;

    if (!pickup && cfg.freeDelivery !== true) {
      const feeSnap = await db.collection("deliveryFees").doc(districtSnap.id).get();
      if (
        !feeSnap.exists || feeSnap.data().active === false ||
        !Number.isFinite(Number(feeSnap.data().fee)) || Number(feeSnap.data().fee) < 0
      ) {
        return out(400, {
          ok: false,
          error: "Delivery fee is not configured for this district."
        }, origin);
      }
      baseFee = Number(feeSnap.data().fee);
    }

    const delivery = pickup || cfg.freeDelivery === true
      ? 0 : Number((baseFee * multiplier).toFixed(2));
    const total = Number(Math.max(0, subtotal - discount + delivery).toFixed(2));

    const orderRef = db.collection("confirmedOrders").doc();
    const counterRef = db.collection("counters").doc("orders");
    let orderNo = "";

    await db.runTransaction(async tx => {
      const counterSnap = await tx.get(counterRef);
      const next = counterSnap.exists ? Number(counterSnap.data().nextNumber || 1) : 1;

      if (!Number.isSafeInteger(next) || next < 1 || next > 999999) {
        throw new Error("Order number sequence needs administrator attention.");
      }

      orderNo = "MCM" + String(next).padStart(6, "0");

      tx.set(orderRef, {
        orderNo,
        customerUid: uid,
        customerName: name,
        customerEmail: token.email || profile.email || "",
        customerPhone: phone,
        accountType: profile.accountType || "retail",
        delivery: {
          regionId: regionSnap.id,
          region: String(region.name || ""),
          districtId: districtSnap.id,
          district: String(district.name || ""),
          townId: townSnap.id,
          town: String(town.name || ""),
          address: extra
        },
        deliveryMethod: pickup ? "pickup" : "home_delivery",
        pickupLocation: pickup ? "Mary Cereal Mix shed" : "",
        items,
        subtotal,
        discount,
        discountSnapshot: {
          freeDelivery: cfg.freeDelivery === true,
          discountActive: cfg.discountActive === true,
          discountType: cfg.discountType || "percent",
          discountValue: Number(cfg.discountValue || 0)
        },
        deliveryFee: delivery,
        baseDeliveryFee: baseFee,
        deliveryMultiplier: multiplier,
        deliveryItemCount: count,
        deliveryFeeTier: count >= 31 ? "bulk_5x" : count >= 5 ? "medium_2x" : "standard_1x",
        total,
        paymentMethod: payment,
        paymentProvider: payment === "momo" ? "MTN Mobile Money" : "Cash",
        momoNumber: payment === "momo" ? "0545628054" : "",
        momoAccountName: payment === "momo" ? "MARY OPOKU WARE" : "",
        paymentReference: orderNo,
        paymentStatus: "pending",
        paidAmount: 0,
        balance: total,
        orderStatus: "Order Received",
        status: "confirmed",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      tx.set(counterRef, {
        nextNumber: next + 1,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });

    try {
      await db.collection("notifications").add({
        type: "new_order",
        title: "New order received",
        message: orderNo + " · GH₵" + total.toFixed(2),
        orderId: orderRef.id,
        orderNo,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (error) {
      console.error("Notification failed", error);
    }

    return out(200, { ok: true, orderId: orderRef.id, orderNo, total }, origin);
  } catch (error) {
    console.error("Secure order error", error);
    return out(500, {
      ok: false,
      error: "We could not submit your order. Please try again or contact the shop."
    }, origin);
  }
};
