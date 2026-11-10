const admin = require("firebase-admin");
const ADMIN_UID = "BzTy6OPheYNFPfhEBgRZavmm0cu2";

function getApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON in Netlify environment.");
  return admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
}
const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const reply = (statusCode, data) => ({ statusCode, headers, body: JSON.stringify(data) });

async function listAuthUsers(auth) {
  const out = []; let token;
  do { const p = await auth.listUsers(1000, token); out.push(...p.users); token = p.pageToken; } while (token);
  return out;
}
async function listCollection(db, name) {
  const s = await db.collection(name).get(); return s.docs;
}
async function deleteInBatches(db, docs) {
  for (let i = 0; i < docs.length; i += 400) {
    const b = db.batch();
    docs.slice(i, i + 400).forEach(d => b.delete(d.ref));
    await b.commit();
  }
}

exports.handler = async event => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return reply(405, { ok:false, error:"POST only." });
  try {
    const authHeader = event.headers?.authorization || event.headers?.Authorization || "";
    const tokenMatch = String(authHeader).match(/^Bearer\s+(.+)$/i);
    if (!tokenMatch) return reply(401, { ok:false, error:"Sign in first." });

    const app = getApp(), auth = admin.auth(app), db = admin.firestore(app);
    const decoded = await auth.verifyIdToken(tokenMatch[1]);
    if (decoded.uid !== ADMIN_UID) return reply(403, { ok:false, error:"Administrator access only." });

    const body = JSON.parse(event.body || "{}");
    if (!["preview","execute"].includes(body.action)) return reply(400,{ok:false,error:"Invalid action."});

    const [authUsers, userDocs, orderDocs, paymentDocs, addressDocs, notificationDocs] = await Promise.all([
      listAuthUsers(auth), listCollection(db,"users"), listCollection(db,"confirmedOrders"),
      listCollection(db,"payments"), listCollection(db,"customerAddresses"), listCollection(db,"notifications")
    ]);

    const customerProfiles = userDocs.filter(d => d.id !== ADMIN_UID && (d.data().role === "customer" || d.data().accountType));
    const customerIds = new Set(customerProfiles.map(d => d.id));
    const customerAuth = authUsers.filter(u => u.uid !== ADMIN_UID);
    const orderIds = new Set(orderDocs.map(d => d.id));
    const paymentsToDelete = paymentDocs.filter(d => {
      const p=d.data() || {};
      return orderIds.has(String(p.orderId || "")) || customerIds.has(String(p.customerUid || p.uid || ""));
    });
    const addressesToDelete = addressDocs.filter(d => {
      const a=d.data() || {};
      return customerIds.has(String(a.customerUid || a.uid || ""));
    });
    const notificationsToDelete = notificationDocs.filter(d => {
      const n=d.data() || {};
      return orderIds.has(String(n.orderId || "")) || ["new_order","order_update"].includes(n.type);
    });

    const counts = {
      customerAuthAccounts: customerAuth.length,
      customerProfiles: customerProfiles.length,
      confirmedOrders: orderDocs.length,
      relatedPaymentRecords: paymentsToDelete.length,
      savedCustomerAddresses: addressesToDelete.length,
      orderNotifications: notificationsToDelete.length
    };
    if (body.action === "preview") return reply(200,{
      ok:true,preview:true,counts,
      preserved:["Admin account/profile","Products, prices and stock","Product images","Delivery areas and fees","Advertisements and knowledge articles","App settings and order counter"],
      warning:"Preview only. No data has been deleted."
    });

    if (body.confirmation !== "DELETE ALL CUSTOMER DATA") return reply(400,{ok:false,error:"Enter the exact confirmation phrase."});
    await auth.getUser(ADMIN_UID);

    // Remove all customer orders, but only payment/address/notification records linked to
    // those orders or customer profiles. Unrelated records in those collections are retained.
    await deleteInBatches(db, orderDocs);
    await deleteInBatches(db, paymentsToDelete);
    await deleteInBatches(db, addressesToDelete);
    await deleteInBatches(db, notificationsToDelete);
    await deleteInBatches(db, customerProfiles);

    // All non-admin Auth accounts are removed as approved in the launch-cleanup scope.
    for (let i=0;i<customerAuth.length;i+=1000) {
      const result=await auth.deleteUsers(customerAuth.slice(i,i+1000).map(u=>u.uid));
      if (result.failureCount) throw new Error(result.failureCount+" Auth account(s) could not be deleted. Check Netlify function logs.");
    }
    return reply(200,{ok:true,deleted:counts,preserved:["Admin account/profile","Products, prices and stock","Product images","Delivery areas and fees","Advertisements and knowledge articles","App settings and order counter"]});
  } catch(e) {
    console.error("Admin cleanup error:",e);
    return reply(500,{ok:false,error:e.message || "Cleanup failed."});
  }
};
