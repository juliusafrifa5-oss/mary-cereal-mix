const admin = require("firebase-admin");
function app(){
 if(admin.apps.length)return admin.app();
 const raw=process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
 if(!raw)throw new Error("Server configuration is incomplete.");
 return admin.initializeApp({credential:admin.credential.cert(JSON.parse(raw))});
}
const allowed=new Set(["https://mary-cereal-mix.netlify.app","https://juliusafrifa5-oss.github.io",...(process.env.ALLOWED_ORIGINS||"").split(",").map(x=>x.trim()).filter(Boolean)]);
function out(status,body,origin){const headers={"Content-Type":"application/json","Cache-Control":"no-store","Vary":"Origin"};if(origin&&allowed.has(origin)){headers["Access-Control-Allow-Origin"]=origin;headers["Access-Control-Allow-Headers"]="Content-Type, Authorization";headers["Access-Control-Allow-Methods"]="POST, OPTIONS";}return{statusCode:status,headers,body:JSON.stringify(body)};}
exports.handler=async event=>{
 const origin=event.headers?.origin||event.headers?.Origin||"";
 if(event.httpMethod==="OPTIONS")return out(204,{},origin);
 if(event.httpMethod!=="POST")return out(405,{ok:false,error:"Method not allowed."},origin);
 try{
  if(origin&&!allowed.has(origin))return out(403,{ok:false,error:"Origin not allowed."},origin);
  const m=(event.headers?.authorization||event.headers?.Authorization||"").match(/^Bearer\s+(.+)$/i);
  if(!m)return out(401,{ok:false,error:"Please sign in again."},origin);
  const fb=app(),db=fb.firestore(),token=await fb.auth().verifyIdToken(m[1]),uid=token.uid;
  let b;try{b=JSON.parse(event.body||"{}");}catch{return out(400,{ok:false,error:"Invalid order request."},origin);}
  if(!Array.isArray(b.items)||!b.items.length||b.items.length>20)return out(400,{ok:false,error:"Your cart is empty or contains too many products."},origin);
  const ps=await db.collection("users").doc(uid).get();
  if(!ps.exists||ps.data().role!=="customer"||ps.data().active===false)return out(403,{ok:false,error:"This account cannot place orders."},origin);
  const p=ps.data(),a=b.address||{},name=String(a.name||p.name||"").trim().slice(0,120),phone=String(a.phone||p.phone||"").trim().slice(0,40),extra=String(a.extra||"").trim().slice(0,500);
  if(!name||!phone)return out(400,{ok:false,error:"Enter your name and contact number."},origin);
  const [rs,ds,ts]=await Promise.all([db.collection("deliveryRegions").doc(String(a.regionId||"")).get(),db.collection("deliveryDistricts").doc(String(a.districtId||"")).get(),db.collection("deliveryTowns").doc(String(a.townId||"")).get()]);
  if(!rs.exists||!ds.exists||!ts.exists)return out(400,{ok:false,error:"Your delivery address is incomplete."},origin);
  const r=rs.data(),d=ds.data(),t=ts.data();
  if(r.active===false||d.active===false||t.active===false||d.regionId!==rs.id||t.districtId!==ds.id)return out(400,{ok:false,error:"The selected delivery area is unavailable."},origin);
  const seen=new Set(),items=[];
  for(const x of b.items){
   const id=String(x.productId||""),qty=Number(x.quantity);
   if(!id||seen.has(id)||!Number.isSafeInteger(qty)||qty<1||qty>1000)return out(400,{ok:false,error:"One or more cart items are invalid."},origin);
   seen.add(id);const snap=await db.collection("products").doc(id).get();
   if(!snap.exists||snap.data().active===false)return out(400,{ok:false,error:"A product in your cart is unavailable."},origin);
   const product=snap.data(),price=Number(product.retailPrice??product.price);
   if(!Number.isFinite(price)||price<0)return out(400,{ok:false,error:"A product price is not configured."},origin);
   if(Number(product.stockQuantity)>0&&qty>Number(product.stockQuantity))return out(409,{ok:false,error:"The requested quantity exceeds the displayed stock."},origin);
   items.push({productId:id,name:String(product.name||"Product"),unit:String(product.unit||"Pack"),quantity:qty,unitPrice:price,lineTotal:Number((price*qty).toFixed(2))});
  }
  const subtotal=Number(items.reduce((s,x)=>s+x.lineTotal,0).toFixed(2));
  const ss=await db.collection("appSettings").doc("checkout").get(),cfg=ss.exists?ss.data():{freeDelivery:false,discountActive:false,discountType:"percent",discountValue:0};
  let discount=0;if(cfg.discountActive===true){const v=Math.max(0,Number(cfg.discountValue)||0);discount=cfg.discountType==="fixed"?Math.min(subtotal,v):subtotal*Math.min(100,v)/100;}discount=Number(discount.toFixed(2));
  const count=items.reduce((s,x)=>s+x.quantity,0),mult=count>=31?5:count>=5?2:1,pickup=b.deliveryMethod==="pickup",payment=b.paymentMethod==="cash"?"cash":"momo";
  let baseFee=0;if(!pickup&&cfg.freeDelivery!==true){const fs=await db.collection("deliveryFees").doc(ds.id).get();if(!fs.exists||fs.data().active===false||!Number.isFinite(Number(fs.data().fee))||Number(fs.data().fee)<0)return out(400,{ok:false,error:"Delivery fee is not configured for this district."},origin);baseFee=Number(fs.data().fee);}
  const delivery=pickup||cfg.freeDelivery===true?0:Number((baseFee*mult).toFixed(2)),total=Number(Math.max(0,subtotal-discount+delivery).toFixed(2));
  const orderRef=db.collection("confirmedOrders").doc(),counterRef=db.collection("counters").doc("orders");let orderNo="";
  await db.runTransaction(async tx=>{
   const cs=await tx.get(counterRef),next=cs.exists?Number(cs.data().nextNumber||1):1;
   if(!Number.isSafeInteger(next)||next<1||next>999999)throw new Error("Order number sequence needs administrator attention.");
   orderNo="MCM"+String(next).padStart(6,"0");
   tx.set(orderRef,{orderNo,customerUid:uid,customerName:name,customerEmail:token.email||p.email||"",customerPhone:phone,accountType:p.accountType||"retail",delivery:{regionId:rs.id,region:String(r.name||""),districtId:ds.id,district:String(d.name||""),townId:ts.id,town:String(t.name||""),address:extra},deliveryMethod:pickup?"pickup":"home_delivery",pickupLocation:pickup?"Mary Cereal Mix shed":"",items,subtotal,discount,discountSnapshot:{freeDelivery:cfg.freeDelivery===true,discountActive:cfg.discountActive===true,discountType:cfg.discountType||"percent",discountValue:Number(cfg.discountValue||0)},deliveryFee:delivery,baseDeliveryFee:baseFee,deliveryMultiplier:mult,deliveryItemCount:count,deliveryFeeTier:count>=31?"bulk_5x":count>=5?"medium_2x":"standard_1x",total,paymentMethod:payment,paymentProvider:payment==="momo"?"MTN Mobile Money":"Cash",momoNumber:payment==="momo"?"0545628054":"",momoAccountName:payment==="momo"?"MARY OPOKU WARE":"",paymentReference:orderNo,paymentStatus:"pending",paidAmount:0,balance:total,orderStatus:"Order Received",status:"confirmed",createdAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
   tx.set(counterRef,{nextNumber:next+1,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
  });
  try{await db.collection("notifications").add({type:"new_order",title:"New order received",message:orderNo+" · GH₵"+total.toFixed(2),orderId:orderRef.id,orderNo,read:false,createdAt:admin.firestore.FieldValue.serverTimestamp()});}catch(e){console.error("Notification failed",e);}
  return out(200,{ok:true,orderId:orderRef.id,orderNo,total},origin);
 }catch(e){console.error("Secure order error",e);return out(500,{ok:false,error:"We could not submit your order. Please try again or contact the shop."},origin);}
};
