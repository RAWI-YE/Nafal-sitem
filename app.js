import { initializeApp, getApps, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { 
  getFirestore, collection, doc, setDoc, getDoc, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// 1. المفاتيح الافتراضية الخاصة بك (أبو تركي)
const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAtCSiIDDN9nceKMj2xZbjREy9qXFEv68k",
  authDomain: "rawi-ye02.firebaseapp.com",
  projectId: "rawi-ye02",
  storageBucket: "rawi-ye02.firebasestorage.app",
  messagingSenderId: "247996335759",
  appId: "1:247996335759:web:846f6e93f75175bddc92fa",
  measurementId: "G-0RDKKNKSJJ"
};

const DEFAULT_IMGBB_KEY = "0fbdc2c45d1d7098137c923129bd25b7";

// جلب الإعدادات المحفوظة محلياً أو استخدام الافتراضية
function getStoredFirebaseConfig() {
  const saved = localStorage.getItem("nafal_fb_config");
  return saved ? JSON.parse(saved) : DEFAULT_FIREBASE_CONFIG;
}

function getStoredImgbbKey() {
  return localStorage.getItem("nafal_imgbb_key") || DEFAULT_IMGBB_KEY;
}

let db = null;
let currentCategories = ["محاصيل مختصة", "أدوات قهوة", "بكجات نفال"];
let allOrders = [];

// 2. تهيئة الاتصال بفايربيس
async function initFirebaseConnection() {
  try {
    const config = getStoredFirebaseConfig();
    if (getApps().length > 0) {
      await deleteApp(getApps()[0]);
    }
    const app = initializeApp(config);
    db = getFirestore(app);

    document.getElementById("dbStatusDot").classList.add("online");
    document.getElementById("dbStatusText").textContent = `متصل بقاعدة: ${config.projectId}`;

    loadSettingsAndOffers();
    listenToProducts();
    listenToOrders();
  } catch (error) {
    console.error("Firebase Init Error:", error);
    document.getElementById("dbStatusDot").classList.remove("online");
    document.getElementById("dbStatusText").textContent = "خطأ في الاتصال بالقاعدة";
  }
}

// إشعار سريع
function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 3000);
}

// 3. التنقل بين التبويبات
document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  });
});

// 4. ضغط الصورة بالمتصفح ورفعها إلى ImgBB تلقائياً
function compressImage(file, maxWidth = 800, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = event => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let width = img.width;
        let height = img.height;

        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        const base64 = dataUrl.split(",")[1];
        resolve(base64);
      };
      img.onerror = err => reject(err);
    };
    reader.onerror = err => reject(err);
  });
}

document.getElementById("prodImageFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById("uploadStatus");
  statusEl.textContent = "⏳ جاري ضغط الصورة ورفعها...";

  try {
    const base64Image = await compressImage(file);
    const apiKey = getStoredImgbbKey();
    const formData = new FormData();
    formData.append("image", base64Image);

    const response = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
      method: "POST",
      body: formData
    });

    const result = await response.json();
    if (result.success) {
      const imageUrl = result.data.display_url;
      document.getElementById("prodImageUrl").value = imageUrl;
      const preview = document.getElementById("prodImagePreview");
      preview.src = imageUrl;
      preview.classList.remove("hidden");
      statusEl.textContent = "✅ تم ضغط ورفع الصورة بنجاح!";
      showToast("تم رفع الصورة وحفظ الرابط");
    } else {
      statusEl.textContent = "❌ فشل الرفع، تأكد من مفتاح ImgBB";
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = "❌ حدث خطأ أثناء ضغط أو رفع الصورة";
  }
});

// 5. إدارة المنتجات (إضافة / تعديل / حذف)
document.getElementById("productForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const editId = document.getElementById("editProductId").value;

  const productData = {
    name: document.getElementById("prodName").value.trim(),
    category: document.getElementById("prodCategory").value,
    price: Number(document.getElementById("prodPrice").value),
    stock: Number(document.getElementById("prodStock").value),
    description: document.getElementById("prodDesc").value.trim(),
    imageUrl: document.getElementById("prodImageUrl").value.trim(),
    freeDelivery: document.getElementById("prodFreeDelivery").checked,
    updatedAt: Date.now()
  };

  try {
    if (editId) {
      await updateDoc(doc(db, "nafal_products", editId), productData);
      showToast("تم تحديث بيانات المنتج بنجاح");
    } else {
      productData.createdAt = Date.now();
      await addDoc(collection(db, "nafal_products"), productData);
      showToast("تمت إضافة المنتج للمتجر بنجاح");
    }
    resetProductForm();
  } catch (err) {
    console.error(err);
    showToast("حدث خطأ أثناء حفظ المنتج");
  }
});

function resetProductForm() {
  document.getElementById("productForm").reset();
  document.getElementById("editProductId").value = "";
  document.getElementById("prodImagePreview").classList.add("hidden");
  document.getElementById("uploadStatus").textContent = "اختر صورة من جهازك ليتم ضغطها ورفعها فوراً";
  document.getElementById("saveProductBtn").textContent = "حفظ المنتج في القاعدة";
}

document.getElementById("resetProductFormBtn").addEventListener("click", resetProductForm);

function listenToProducts() {
  const q = query(collection(db, "nafal_products"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snapshot) => {
    const container = document.getElementById("productsList");
    container.innerHTML = "";

    if (snapshot.empty) {
      container.innerHTML = `<p class="hint-text">لا توجد منتجات مضافة حالياً. أضف أول محصول من الأعلى.</p>`;
      return;
    }

    snapshot.forEach(docSnap => {
      const p = docSnap.data();
      const id = docSnap.id;
      const card = document.createElement("div");
      card.className = "product-card";
      card.innerHTML = `
        <img src="${p.imageUrl}" alt="${p.name}">
        <div class="product-card-body">
          <div class="product-card-title">${p.name}</div>
          <div class="hint-text">${p.category} | المخزون: ${p.stock}</div>
          <div class="product-card-meta">
            <span>${p.price} ريال</span>
            <span>${p.freeDelivery ? "🚚 معفي من التوصيل" : ""}</span>
          </div>
          <div class="product-card-actions">
            <button class="btn-secondary edit-btn" style="flex:1">تعديل</button>
            <button class="btn-danger del-btn">حذف</button>
          </div>
        </div>
      `;

      card.querySelector(".edit-btn").addEventListener("click", () => {
        document.getElementById("editProductId").value = id;
        document.getElementById("prodName").value = p.name;
        document.getElementById("prodCategory").value = p.category;
        document.getElementById("prodPrice").value = p.price;
        document.getElementById("prodStock").value = p.stock;
        document.getElementById("prodDesc").value = p.description || "";
        document.getElementById("prodImageUrl").value = p.imageUrl;
        document.getElementById("prodFreeDelivery").checked = !!p.freeDelivery;
        const preview = document.getElementById("prodImagePreview");
        preview.src = p.imageUrl;
        preview.classList.remove("hidden");
        document.getElementById("saveProductBtn").textContent = "تحديث المنتج";
        window.scrollTo({ top: 0, behavior: "smooth" });
      });

      card.querySelector(".del-btn").addEventListener("click", async () => {
        if (confirm(`هل أنت متأكد من حذف "${p.name}"؟`)) {
          await deleteDoc(doc(db, "nafal_products", id));
          showToast("تم حذف المنتج");
        }
      });

      container.appendChild(card);
    });
  });
}

// 6. إدارة الإعدادات العامة، العروض، التوصيل، والأقسام
async function loadSettingsAndOffers() {
  try {
    const docRef = doc(db, "nafal_settings", "storeConfig");
    const snap = await getDoc(docRef);

    if (snap.exists()) {
      const data = snap.data();
      // تعبئة العروض والتوصيل
      document.getElementById("bannerText").value = data.bannerText || "المتجر يوصل لداخل شرورة فقط 🚚";
      document.getElementById("promoMessage").value = data.promoMessage || "اطلب بـ 100 ريال والتوصيل بـ 5 ريال! وعند الطلب بـ 300 ريال التوصيل مجاني!";
      document.getElementById("baseDeliveryFee").value = data.baseDeliveryFee ?? 15;
      document.getElementById("enableSmartOffers").checked = data.enableSmartOffers ?? true;
      document.getElementById("tier1Threshold").value = data.tier1Threshold ?? 100;
      document.getElementById("tier1Fee").value = data.tier1Fee ?? 5;
      document.getElementById("tier2Threshold").value = data.tier2Threshold ?? 300;
      document.getElementById("tier2Fee").value = data.tier2Fee ?? 0;

      // تعبئة التواصل
      document.getElementById("storeNameInput").value = data.storeName || "NAFAL Specialty Roast | نفال للقهوة المختصة";
      document.getElementById("whatsappNumberInput").value = data.whatsappNumber || "";
      document.getElementById("snapchatUrlInput").value = data.snapchatUrl || "";
      document.getElementById("tiktokUrlInput").value = data.tiktokUrl || "";

      // تعبئة الأقسام
      if (Array.isArray(data.categories) && data.categories.length > 0) {
        currentCategories = data.categories;
      }
      renderCategories();
    } else {
      // إنشاء إعدادات افتراضية أول مرة في القاعدة
      await setDoc(docRef, {
        storeName: "NAFAL Specialty Roast | نفال للقهوة المختصة",
        bannerText: "المتجر يوصل لداخل شرورة فقط 🚚",
        promoMessage: "اطلب بـ 100 ريال والتوصيل بـ 5 ريال! وعند الطلب بـ 300 ريال التوصيل مجاني!",
        baseDeliveryFee: 15,
        enableSmartOffers: true,
        tier1Threshold: 100,
        tier1Fee: 5,
        tier2Threshold: 300,
        tier2Fee: 0,
        whatsappNumber: "966500000000",
        snapchatUrl: "",
        tiktokUrl: "",
        categories: currentCategories
      });
      renderCategories();
    }
  } catch (err) {
    console.error("Load Settings Error:", err);
  }
}

document.getElementById("offersForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await setDoc(doc(db, "nafal_settings", "storeConfig"), {
      bannerText: document.getElementById("bannerText").value.trim(),
      promoMessage: document.getElementById("promoMessage").value.trim(),
      baseDeliveryFee: Number(document.getElementById("baseDeliveryFee").value),
      enableSmartOffers: document.getElementById("enableSmartOffers").checked,
      tier1Threshold: Number(document.getElementById("tier1Threshold").value),
      tier1Fee: Number(document.getElementById("tier1Fee").value),
      tier2Threshold: Number(document.getElementById("tier2Threshold").value),
      tier2Fee: Number(document.getElementById("tier2Fee").value)
    }, { merge: true });
    showToast("تم حفظ إعدادات التوصيل والعروض والشريط العلوي");
  } catch (err) {
    console.error(err);
    showToast("خطأ في حفظ العروض");
  }
});

document.getElementById("contactSettingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await setDoc(doc(db, "nafal_settings", "storeConfig"), {
      storeName: document.getElementById("storeNameInput").value.trim(),
      whatsappNumber: document.getElementById("whatsappNumberInput").value.trim(),
      snapchatUrl: document.getElementById("snapchatUrlInput").value.trim(),
      tiktokUrl: document.getElementById("tiktokUrlInput").value.trim()
    }, { merge: true });
    showToast("تم حفظ رقم الواتساب وحسابات التواصل");
  } catch (err) {
    console.error(err);
    showToast("خطأ في حفظ الإعدادات");
  }
});

// 7. إدارة الأقسام
function renderCategories() {
  const select = document.getElementById("prodCategory");
  const list = document.getElementById("categoriesList");
  select.innerHTML = "";
  list.innerHTML = "";

  currentCategories.forEach((cat, index) => {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    select.appendChild(opt);

    const li = document.createElement("li");
    li.className = "cat-item";
    li.innerHTML = `
      <span>${cat}</span>
      <button class="btn-danger" data-index="${index}">حذف</button>
    `;
    li.querySelector("button").addEventListener("click", async () => {
      currentCategories.splice(index, 1);
      await setDoc(doc(db, "nafal_settings", "storeConfig"), { categories: currentCategories }, { merge: true });
      renderCategories();
      showToast("تم حذف القسم");
    });
    list.appendChild(li);
  });
}

document.getElementById("addCategoryBtn").addEventListener("click", async () => {
  const input = document.getElementById("newCategoryInput");
  const val = input.value.trim();
  if (!val) return;
  if (!currentCategories.includes(val)) {
    currentCategories.push(val);
    await setDoc(doc(db, "nafal_settings", "storeConfig"), { categories: currentCategories }, { merge: true });
    renderCategories();
    input.value = "";
    showToast("تمت إضافة القسم");
  }
});

// 8. متابعة الفواتير والطلبات المباشرة وتحديث حالتها للعميل
function listenToOrders() {
  const q = query(collection(db, "nafal_orders"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snapshot) => {
    allOrders = [];
    snapshot.forEach(docSnap => {
      allOrders.push({ id: docSnap.id, ...docSnap.data() });
    });
    document.getElementById("ordersBadge").textContent = allOrders.filter(o => o.status === "جديد - قيد المراجعة").length;
    renderOrders();
  });
}

document.getElementById("orderStatusFilter").addEventListener("change", renderOrders);

function renderOrders() {
  const filter = document.getElementById("orderStatusFilter").value;
  const container = document.getElementById("ordersContainer");
  container.innerHTML = "";

  const filtered = filter === "all" ? allOrders : allOrders.filter(o => o.status === filter);

  if (filtered.length === 0) {
    container.innerHTML = `<p class="hint-text">لا توجد فواتير مطابقة حالياً.</p>`;
    return;
  }

  filtered.forEach(order => {
    const card = document.createElement("div");
    card.className = "order-card";

    const itemsHtml = (order.items || []).map(i => `• ${i.name} (${i.qty} × ${i.price} ريال)`).join("<br>");
    const mapLink = order.gpsLocation ? `<a href="${order.gpsLocation}" target="_blank" class="map-link">📍 فتح موقع العميل (GPS) على الخريطة</a>` : "لم يحدد رابط GPS";

    const statusOptions = [
      "جديد - قيد المراجعة",
      "جاري التحميص والتجهيز",
      "مع المندوب للتوصيل",
      "تم التوصيل",
      "ملغي"
    ].map(st => `<option value="${st}" ${order.status === st ? "selected" : ""}>${st}</option>`).join("");

    const customerPhone = (order.customerPhone || "").replace(/[^0-9]/g, "");
    const waUpdateMsg = encodeURIComponent(
      `مرحباً ${order.customerName} ☕\nتحديث بخصوص فاتورتك رقم (#${order.invoiceNumber}) في متجر نفال للقهوة المختصة:\nالحالة الحالية: *${order.status}*\nإجمالي الفاتورة: ${order.totalAmount} ريال.`
    );

    card.innerHTML = `
      <div class="order-header">
        <span class="invoice-id">فاتورة #${order.invoiceNumber}</span>
        <span class="hint-text">${new Date(order.createdAt).toLocaleString("ar-SA")}</span>
      </div>
      <div>
        <strong>العميل:</strong> ${order.customerName}<br>
        <strong>الجوال:</strong> ${order.customerPhone}<br>
        <strong>العنوان/ملاحظة:</strong> ${order.customerAddress || "داخل شرورة"}<br>
        ${mapLink}
      </div>
      <div class="order-items-list">${itemsHtml}</div>
      <div class="order-totals">
        <span>التوصيل: ${order.deliveryFee} ريال</span>
        <span>الإجمالي: ${order.totalAmount} ريال</span>
      </div>
      <div class="order-actions">
        <label class="hint-text">تحديث حالة الفاتورة (تظهر للعميل فوراً):</label>
        <select class="status-select">${statusOptions}</select>
        <a href="https://wa.me/${customerPhone}?text=${waUpdateMsg}" target="_blank" class="whatsapp-btn">💬 إشعار العميل عبر واتساب</a>
      </div>
    `;

    card.querySelector(".status-select").addEventListener("change", async (e) => {
      const newStatus = e.target.value;
      await updateDoc(doc(db, "nafal_orders", order.id), {
        status: newStatus,
        updatedAt: Date.now()
      });
      showToast(`تم تحديث الفاتورة #${order.invoiceNumber} إلى: ${newStatus}`);
    });

    container.appendChild(card);
  });
}

// 9. إدارة مفاتيح Firebase و ImgBB وتوليد الكود تلقائياً
function populateKeysForm() {
  const fb = getStoredFirebaseConfig();
  document.getElementById("imgbbKeyInput").value = getStoredImgbbKey();
  document.getElementById("fbApiKey").value = fb.apiKey || "";
  document.getElementById("fbAuthDomain").value = fb.authDomain || "";
  document.getElementById("fbProjectId").value = fb.projectId || "";
  document.getElementById("fbStorageBucket").value = fb.storageBucket || "";
  document.getElementById("fbMessagingSenderId").value = fb.messagingSenderId || "";
  document.getElementById("fbAppId").value = fb.appId || "";
  updateGeneratedCodeBox(fb);
}

function updateGeneratedCodeBox(fbConfig) {
  const code = `const firebaseConfig = ${JSON.stringify(fbConfig, null, 2)};`;
  document.getElementById("generatedFirebaseCode").value = code;
}

document.getElementById("keysConfigForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const newFbConfig = {
    apiKey: document.getElementById("fbApiKey").value.trim(),
    authDomain: document.getElementById("fbAuthDomain").value.trim(),
    projectId: document.getElementById("fbProjectId").value.trim(),
    storageBucket: document.getElementById("fbStorageBucket").value.trim(),
    messagingSenderId: document.getElementById("fbMessagingSenderId").value.trim(),
    appId: document.getElementById("fbAppId").value.trim()
  };
  const newImgbbKey = document.getElementById("imgbbKeyInput").value.trim();

  localStorage.setItem("nafal_fb_config", JSON.stringify(newFbConfig));
  localStorage.setItem("nafal_imgbb_key", newImgbbKey);

  updateGeneratedCodeBox(newFbConfig);
  await initFirebaseConnection();
  showToast("تم تحديث المفاتيح وإعادة ربط قاعدة البيانات بنجاح!");
});

document.getElementById("resetDefaultKeysBtn").addEventListener("click", async () => {
  localStorage.removeItem("nafal_fb_config");
  localStorage.removeItem("nafal_imgbb_key");
  populateKeysForm();
  await initFirebaseConnection();
  showToast("تمت استعادة مفاتيحك الافتراضية");
});

// تشغيل النظام عند فتح الصفحة
populateKeysForm();
initFirebaseConnection();
