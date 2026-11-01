MARY CEREAL MIX — SECURITY-FIRST STARTER

1) Upload index.html to your web host (Firebase Hosting / GitHub Pages).
2) Publish firestore.rules in Firebase Console > Firestore Database > Rules.
3) Firebase Console > Authentication > Sign-in method: enable Email/Password.
4) Create your own admin login through the app first. Copy its Firebase Authentication UID.
5) In Firestore, create users/{YOUR_UID} with fields:
   name (string), phone (string), email (string),
   accountType (string: "retail"), wholesaleStatus (string: "not_applicable"),
   role (string: "admin").
   Never give customers role=admin.
6) Add products and separate price documents using the admin screen. Prices are stored separately:
   products/{productId} has product details but no prices.
   retailPrices/{productId} has price.
   wholesalePrices/{productId} has price.
7) Customer orders are REQUESTS only: they contain product/quantity, not trusted totals or payment data.
   Admin reviews the request, enters the agreed total and confirms it. Admin alone records payments.
8) Cloudinary unsigned upload presets are public and can be abused by anyone who knows the preset. Set format and size restrictions in Cloudinary. For production-grade upload protection, use a signed-upload backend; this starter's unsigned upload is not an authentication boundary.
9) Before real use, test with separate retail, pending-wholesale, approved-wholesale and admin accounts. Verify that retail cannot read wholesalePrices and pending wholesale cannot read wholesalePrices.
10) This is a starter application, not a fully audited commercial system. It does not yet implement stock decrement, delivery workflow, downloadable receipts, export reports, password reset UI, or automated customer notifications. Do not use for live transactions until tested.
11) Never share Firebase service-account keys, private keys, passwords or Cloudinary API Secret.
