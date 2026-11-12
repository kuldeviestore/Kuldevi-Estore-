const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

function getDb() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable.");
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });
  return getFirestore(app);
}

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed." });

  try {
    const body = JSON.parse(event.body || "{}");
    const requestId = String(body.requestId || "");
    const customerName = String(body.customerName || "").trim();
    const customerPhone = String(body.customerPhone || "").trim();
    const customerAddress = String(body.customerAddress || "").trim();
    const rawItems = Array.isArray(body.items) ? body.items : [];

    if (!/^[A-Za-z0-9_-]{12,100}$/.test(requestId)) return reply(400, { error: "Invalid order request. Please retry." });
    if (customerName.length < 2 || customerName.length > 100) return reply(400, { error: "Please enter a valid customer name." });
    if (!/^[0-9+() -]{10,18}$/.test(customerPhone)) return reply(400, { error: "Please enter a valid mobile number." });
    if (customerAddress.length < 8 || customerAddress.length > 1000) return reply(400, { error: "Please enter a complete delivery address." });
    if (!rawItems.length || rawItems.length > 30) return reply(400, { error: "Your cart is empty or contains too many items." });

    const quantities = new Map();
    for (const item of rawItems) {
      const id = String(item.productId || "");
      const qty = Number(item.quantity);
      if (!/^[A-Za-z0-9_-]{1,150}$/.test(id) || !Number.isSafeInteger(qty) || qty < 1 || qty > 99) {
        return reply(400, { error: "Invalid product or quantity in your cart." });
      }
      quantities.set(id, (quantities.get(id) || 0) + qty);
    }
    if ([...quantities.values()].some(q => q > 99)) return reply(400, { error: "Maximum quantity per product is 99." });

    const db = getDb();
    const result = await db.runTransaction(async tx => {
      const requestRef = db.collection("orderRequests").doc(requestId);
      const requestSnap = await tx.get(requestRef);
      if (requestSnap.exists) {
        return { orderId: requestSnap.data().orderId, duplicate: true };
      }

      const entries = [...quantities.entries()];
      const productRefs = entries.map(([id]) => db.collection("products").doc(id));
      const productSnaps = await Promise.all(productRefs.map(ref => tx.get(ref)));
      const orderItems = [];
      let total = 0;

      for (let i = 0; i < entries.length; i++) {
        const [productId, quantity] = entries[i];
        const snap = productSnaps[i];
        if (!snap.exists) throw new Error("A product in your cart is no longer available.");
        const p = snap.data();
        const stock = Number(p.stock);
        if (!Number.isSafeInteger(stock) || stock < 0) throw new Error("Stock data needs admin correction for " + (p.name || "a product") + ".");
        if (stock < quantity) throw new Error((p.name || "A product") + " has only " + stock + " item(s) left. Please update your cart.");

        const unitPrice = round2(Number(p.finalPrice ?? Number(p.price || 0) * (1 + Number(p.gstRate || 0) / 100)));
        if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error("Invalid price for " + (p.name || "a product") + ".");
        const lineTotal = round2(unitPrice * quantity);
        total = round2(total + lineTotal);
        orderItems.push({
          productId,
          name: String(p.name || "Product"),
          sku: String(p.sku || ""),
          price: unitPrice,
          quantity,
          lineTotal
        });
      }

      const orderRef = db.collection("orders").doc();
      for (let i = 0; i < entries.length; i++) {
        const [productId, quantity] = entries[i];
        tx.update(productRefs[i], {
          stock: Number(productSnaps[i].data().stock) - quantity,
          updatedAt: Date.now(),
          inventoryUpdatedAt: FieldValue.serverTimestamp()
        });
      }
      tx.create(orderRef, {
        customerName, customerPhone, customerAddress,
        items: orderItems, total,
        paymentMethod: "COD",
        paymentStatus: "Cash on Delivery",
        status: "Pending",
        createdAt: Date.now(),
        createdAtServer: FieldValue.serverTimestamp()
      });
      tx.create(requestRef, { orderId: orderRef.id, createdAt: Date.now() });
      return { orderId: orderRef.id, duplicate: false };
    });

    return reply(200, { success: true, orderId: result.orderId, duplicate: result.duplicate, paymentMethod: "COD" });
  } catch (error) {
    console.error("place-order error:", error);
    const msg = error && error.message ? error.message : "Order could not be placed.";
    const code = /only [0-9]+ item|no longer available|stock data|Invalid price/i.test(msg) ? 409 : 400;
    return reply(code, { error: msg });
  }
};
