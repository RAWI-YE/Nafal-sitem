import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { 
  initializeFirestore, getFirestore, collection, doc, setDoc, getDoc, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy 
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

// صورة قهوة مختصة افتراضية في حال لم يرفع المستخدم صورة
const DEFAULT_COFFEE_IMG = "https://images.unsplash.com/photo-1559056199-641a0ac8b55e?auto=format&fit=crop&w=800&q=80";

function getStoredFirebaseConfig() {
  try {
    const saved = localStorage.getItem("nafal_fb_config");
    return saved ? JSON.parse(saved) : DEFAULT_FIREBASE_CONFIG;
  } catch {
    return DEFAULT_FIREBASE_CONFIG;
  }
}

function getStoredImgbbKey() {
  return localStorage.getItem("nafal_imgbb_key") || DEFAULT_IMGBB_KEY;
}

let db = null;
let currentCategories = ["محاصيل مختصة", "أدوات قهوة", "بكجات نفال"];
let allOrders = [];

// إشعار عائم زجاجي
function showToast(msg) {
  const toast = document.getElementById("toast");
  document.getElementById("toastText").textContent = msg;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 3500);
}

// 2. نظام التشخيص الذكي لأخطاء قاعدة البيانات
function handleFirebaseError(err, contextText = "") {
  console.error(`Firebase Error [${contextText}]:`, err);
  const dot = document.getElementById("dbStatusDot");
  const statusText = document.getElementById("dbStatusText");
  const diagBox = document.getElementById("diagnosticAlert");
  const diagTitle = document.getElementById("diagTitle");
  const diagDesc = document.getElementById("diagDesc");

  dot.classList.remove("online");
  dot.classList.add("error");

  const code = err.code || "";
  if (code.includes("permission-denied")) {
    statusText.textContent = "القاعدة مقفلة (Permission Denied)";
    diagTitle.textContent = "تم اكتشاف السبب: قواعد الأمان (Rules) في فايربيس مغلقة!";
    diagDesc.textContent = "قاعدة بياناتك متصلة وموجودة، لكن فايربيس ترفض حفظ المنتج لأن القواعد (Rules) موضوعة على وضع القفل. انسخ الكود بالأسفل وضعه في حسابك بفايربيس (Firestore Database -> Rules) واضغط Publish وسيعمل الحفظ فوراً.";
    diagBox.classList.remove("hidden");
    showToast("يرجى فتح صلاحيات القاعدة (Rules) في فايربيس");
  } else if (code.includes("not-found") || (err.message && err.message.includes("database (default) does not exist"))) {
    statusText.textContent = "لم يتم إنشاء Firestore بعد";
    diagTitle.textContent = "تم اكتشاف السبب: لم تقم بإنشاء Firestore Database داخل مشروعك!";
    diagDesc.textContent = "ادخل إلى مشروعك (rawi-ye02) في موقع Firebase، ثم من القائمة الجانبية اختر Build ثم Firestore Database واضغط Create Database واختر Start in test mode.";
    diagBox.classList.remove("hidden");
    showToast("يرجى الضغط على Create Database في فايربيس");
  } else {
    statusText.textContent = `تنبيه اتصال (${code || "تحقق من الإنترنت"})`;
    showToast(`خطأ أثناء ${contextText}: ${err.message || code}`);
  }
}

// 3. تهيئة الاتصال بفايربيس مع تفعيل Long Polling لمنع التعليق
function initFirebaseConnection() {
  try {
    const config = getStoredFirebaseConfig();
    let app;
    if (getApps().length === 0) {
      app = initializeApp(config);
      db = initializeFirestore(app, { experimentalForceLongPolling: true });
    } else {
      app = getApps()[0];
      db = getFirestore(app);
    }

    document.getElementById("dbStatusDot").classList.remove("error");
    document.getElementById("dbStatusDot").classList.add("online");
    document.getElementById("dbStatusText").textContent = `متصل بـ ${config.projectId}`;

    loadSettingsAndOffers();
    listenToProducts();
    listenToOrders();
  } catch (error) {
    handleFirebaseError(error, "تهيئة القاعدة");
  }
}

// زر فحص الاتصال المباشر بقاعدة البيانات
document.getElementById("testDbBtn").addEventListener("click", async () => {
  showToast("جاري اختبار الكتابة والقراءة في القاعدة...");
  try {
    await setDoc(doc(db, "nafal_settings", "connectionTest"), {
      testedAt: Date.now(),
      status: "ok"
    });
    document.getElementById("diagnosticAlert").classList.add("hidden");
    document.getElementById("dbStatusDot").classList.remove("error");
    document.getElementById("dbStatusDot").classList.add("online");
    document.getElementById("dbStatusText").textContent = "القاعدة تعمل 100% (قراءة وكتابة)";
    showToast("ممتاز! قاعدة البيانات متصلة وتقبل الحفظ بنجاح");
  } catch (err) {
    handleFirebaseError(err, "فحص القاعدة");
  }
});

// 4. التنقل بين التبويبات
document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  });
});

// 5. ضغط الصور ورفعها إلى ImgBB
function compressImage(file, maxWidth = 800, quality = 0.82) {
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
        resolve(dataUrl.split(",")[1]);
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
  statusEl.textContent = "جاري ضغط الصورة ورفعها الآن...";

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
      statusEl.textContent = "تم ضغط ورفع الصورة بنجاح";
      showToast("تم رفع الصورة وتجهيز الرابط");
    } else {
      statusEl.textContent = "تعذر الرفع، تحقق من مفتاح ImgBB أو ضع رابطاً يدوياً";
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = "حدث خطأ أثناء رفع الصورة";
  }
});

// 6. حفظ وتعديل المنتجات (بدون أخطاء أو تعليق)
document.getElementById("productForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const saveBtn = document.getElementById("saveProductBtn");
  const editId = document.getElementById("editProductId").value.trim();

  const rawImageUrl = document.getElementById("prodImageUrl").value.trim();
  const productData = {
    name: document.getElementById("prodName").value.trim(),
    category: document.getElementById("prodCategory").value || "محاصيل مختصة",
    price: Number(document.getElementById("prodPrice").value) || 0,
    stock: Number(document.getElementById("prodStock").value) || 0,
    description: document.getElementById("prodDesc").value.trim(),
    imageUrl: rawImageUrl || DEFAULT_COFFEE_IMG,
    freeDelivery: document.getElementById("prodFreeDelivery").checked,
    updatedAt: Date.now()
  };

  saveBtn.disabled = true;
  saveBtn.innerHTML = `<i class="ri-loader-4-line spin-icon"></i><span>جاري الحفظ في القاعدة...</span>`;

  try {
    if (editId) {
      await updateDoc(doc(db, "nafal_products", editId), productData);
      showToast("تم تحديث بيانات المنتج بنجاح");
    } else {
      productData.createdAt = Date.now();
      await addDoc(collection(db, "nafal_products"), productData);
      showToast("تمت إضافة المنتج للمتجر بنجاح");
    }
    document.getElementById("diagnosticAlert").classList.add("hidden");
    resetProductForm();
  } catch (err) {
    handleFirebaseError(err, "حفظ المنتج");
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = `<i class="ri-save-3-line"></i><span>حفظ المنتج في قاعدة البيانات</span>`;
  }
});

function resetProductForm() {
  document.getElementById("productForm").reset();
  document.getElementById("editProductId").value = "";
  document.getElementById("prodImagePreview").classList.add("hidden");
  document.getElementById("uploadStatus").textContent = "اضغط هنا لاختيار صورة من جهازك (يتم ضغطها ورفعها فوراً)";
  document.getElementById("saveProductBtn").innerHTML = `<i class="ri-save-3-line"></i><span>حفظ المنتج في قاعدة البيانات</span>`;
}

document.getElementById("resetProductFormBtn").addEventListener("click", resetProductForm);

function listenToProducts() {
  const q = query(collection(db, "nafal_products"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snapshot) => {
    const container = document.getElementById("productsList");
    container.innerHTML = "";

    if (snapshot.empty) {
      container.innerHTML = `
        <div class="empty-box glass-panel">
          <i class="ri-cup-line"></i>
          <span>لا توجد منتجات مضافة حالياً. أضف أول محصول من النموذج أعلاه.</span>
        </div>
      `;
      return;
    }

    snapshot.forEach(docSnap => {
      const p = docSnap.data();
      const id = docSnap.id;
      const card = document.createElement("div");
      card.className = "product-card";
      card.innerHTML = `
        <img src="${p.imageUrl || DEFAULT_COFFEE_IMG}" alt="${p.name}">
        <div class="product-card-body">
          <div class="product-card-title">${p.name}</div>
          <div style="font-size:0.84rem; color:var(--text-secondary);">${p.category} | المخزون: ${p.stock}</div>
          <div class="product-card-meta">
            <span>${p.price} ريال</span>
            <span>${p.freeDelivery ? "معفي من التوصيل" : ""}</span>
          </div>
          <div class="product-card-actions">
            <button type="button" class="btn-glass edit-btn" style="flex:1; justify-content:center;">
              <i class="ri-edit-line"></i><span>تعديل</span>
            </button>
            <button type="button" class="btn-danger-glass del-btn">
              <i class="ri-delete-bin-line"></i>
            </button>
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
        document.getElementById("prodImageUrl").value = p.imageUrl || "";
        document.getElementById("prodFreeDelivery").checked = !!p.freeDelivery;
        const preview = document.getElementById("prodImagePreview");
        preview.src = p.imageUrl || DEFAULT_COFFEE_IMG;
        preview.classList.remove("hidden");
        document.getElementById("saveProductBtn").innerHTML = `<i class="ri-check-line"></i><span>تحديث بيانات المنتج</span>`;
        window.scrollTo({ top: 0, behavior: "smooth" });
      });

      card.querySelector(".del-btn").addEventListener("click", async () => {
        if (confirm(`هل أنت متأكد من حذف "${p.name}"؟`)) {
          try {
            await deleteDoc(doc(db, "nafal_products", id));
            showToast("تم حذف المنتج");
          } catch (err) {
            handleFirebaseError(err, "حذف المنتج");
          }
        }
      });

      container.appendChild(card);
    });
  }, (err) => {
    handleFirebaseError(err, "قراءة المنتجات");
  });
}

// 7. إدارة الإعدادات، العروض، التوصيل، والأقسام
async function loadSettingsAndOffers() {
  try {
    const docRef = doc(db, "nafal_settings", "storeConfig");
    const snap = await getDoc(docRef);

    if (snap.exists()) {
      const data = snap.data();
      document.getElementById("bannerText").value = data.bannerText || "المتجر يوصل لداخل شرورة فقط";
      document.getElementById("promoMessage").value = data.promoMessage || "اطلب بـ 100 ريال والتوصيل بـ 5 ريال! وعند الطلب بـ 300 ريال التوصيل مجاني!";
      document.getElementById("baseDeliveryFee").value = data.baseDeliveryFee ?? 15;
      document.getElementById("enableSmartOffers").checked = data.enableSmartOffers ?? true;
      document.getElementById("tier1Threshold").value = data.tier1Threshold ?? 100;
      document.getElementById("tier1Fee").value = data.tier1Fee ?? 5;
      document.getElementById("tier2Threshold").value = data.tier2Threshold ?? 300;
      document.getElementById("tier2Fee").value = data.tier2Fee ?? 0;

      document.getElementById("storeNameInput").value = data.storeName || "NAFAL Specialty Roast";
      document.getElementById("whatsappNumberInput").value = data.whatsappNumber || "";
      document.getElementById("snapchatUrlInput").value = data.snapchatUrl || "";
      document.getElementById("tiktokUrlInput").value = data.tiktokUrl || "";

      if (Array.isArray(data.categories) && data.categories.length > 0) {
        currentCategories = data.categories;
      }
      renderCategories();
    } else {
      await setDoc(docRef, {
        storeName: "NAFAL Specialty Roast",
        bannerText: "المتجر يوصل لداخل شرورة فقط",
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
    handleFirebaseError(err, "تحميل الإعدادات");
  }
}

document.getElementById("offersForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await setDoc(doc(db, "nafal_settings", "storeConfig"), {
      bannerText: document.getElementById("bannerText").value.trim(),
      promoMessage: document.getElementById("promoMessage").value.trim(),
      baseDeliveryFee: Number(document.getElementById("baseDeliveryFee").value) || 0,
      enableSmartOffers: document.getElementById("enableSmartOffers").checked,
      tier1Threshold: Number(document.getElementById("tier1Threshold").value) || 100,
      tier1Fee: Number(document.getElementById("tier1Fee").value) || 0,
      tier2Threshold: Number(document.getElementById("tier2Threshold").value) || 300,
      tier2Fee: Number(document.getElementById("tier2Fee").value) || 0
    }, { merge: true });
    showToast("تم حفظ إعدادات التوصيل والعروض والشريط العلوي");
  } catch (err) {
    handleFirebaseError(err, "حفظ العروض");
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
    handleFirebaseError(err, "حفظ بيانات التواصل");
  }
});

// 8. إدارة الأقسام
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
    li.className = "cat-item glass-inset";
    li.innerHTML = `
      <span><i class="ri-price-tag-3-line" style="color:var(--caramel); margin-left:6px;"></i>${cat}</span>
      <button type="button" class="btn-danger-glass" data-index="${index}">
        <i class="ri-delete-bin-line"></i><span>حذف</span>
      </button>
    `;
    li.querySelector("button").addEventListener("click", async () => {
      currentCategories.splice(index, 1);
      try {
        await setDoc(doc(db, "nafal_settings", "storeConfig"), { categories: currentCategories }, { merge: true });
        renderCategories();
        showToast("تم حذف القسم");
      } catch (err) {
        handleFirebaseError(err, "حذف القسم");
      }
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
    try {
      await setDoc(doc(db, "nafal_settings", "storeConfig"), { categories: currentCategories }, { merge: true });
      renderCategories();
      input.value = "";
      showToast("تمت إضافة القسم بنجاح");
    } catch (err) {
      handleFirebaseError(err, "إضافة قسم");
    }
  }
});

// 9. متابعة الفواتير والطلبات المباشرة
function listenToOrders() {
  const q = query(collection(db, "nafal_orders"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snapshot) => {
    allOrders = [];
    snapshot.forEach(docSnap => {
      allOrders.push({ id: docSnap.id, ...docSnap.data() });
    });
    document.getElementById("ordersBadge").textContent = allOrders.filter(o => o.status === "جديد - قيد المراجعة").length;
    renderOrders();
  }, (err) => {
    handleFirebaseError(err, "قراءة الطلبات");
  });
}

document.getElementById("orderStatusFilter").addEventListener("change", renderOrders);

function renderOrders() {
  const filter = document.getElementById("orderStatusFilter").value;
  const container = document.getElementById("ordersContainer");
  container.innerHTML = "";

  const filtered = filter === "all" ? allOrders : allOrders.filter(o => o.status === filter);

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-box glass-panel">
        <i class="ri-inbox-2-line"></i>
        <span>لا توجد فواتير مطابقة حالياً</span>
      </div>
    `;
    return;
  }

  filtered.forEach(order => {
    const card = document.createElement("div");
    card.className = "order-card glass-panel";

    const itemsHtml = (order.items || []).map(i => `• ${i.name} (${i.qty} × ${i.price} ريال)`).join("<br>");
    const mapLink = order.gpsLocation 
      ? `<a href="${order.gpsLocation}" target="_blank" class="map-link"><i class="ri-map-pin-line"></i> فتح موقع العميل (GPS) على الخريطة</a>` 
      : "لم يحدد رابط GPS";

    const statusOptions = [
      "جديد - قيد المراجعة",
      "جاري التحميص والتجهيز",
      "مع المندوب للتوصيل",
      "تم التوصيل",
      "ملغي"
    ].map(st => `<option value="${st}" ${order.status === st ? "selected" : ""}>${st}</option>`).join("");

    const customerPhone = (order.customerPhone || "").replace(/[^0-9]/g, "");
    const waUpdateMsg = encodeURIComponent(
      `مرحباً ${order.customerName}\nتحديث بخصوص فاتورتك رقم (#${order.invoiceNumber}) في متجر نفال للقهوة المختصة:\nالحالة الحالية: *${order.status}*\nإجمالي الفاتورة: ${order.totalAmount} ريال.`
    );

    card.innerHTML = `
      <div class="order-header">
        <span class="invoice-id"><i class="ri-receipt-line" style="color:var(--caramel);"></i> فاتورة #${order.invoiceNumber}</span>
        <span style="font-size:0.8rem; color:var(--text-secondary);">${new Date(order.createdAt).toLocaleString("ar-SA")}</span>
      </div>
      <div style="font-size:0.92rem; line-height:1.6;">
        <strong>العميل:</strong> ${order.customerName}<br>
        <strong>الجوال:</strong> ${order.customerPhone}<br>
        <strong>العنوان:</strong> ${order.customerAddress || "داخل شرورة"}<br>
        ${mapLink}
      </div>
      <div class="order-items-list glass-inset">${itemsHtml}</div>
      <div class="order-totals">
        <span>التوصيل: ${order.deliveryFee} ريال</span>
        <span>الإجمالي: ${order.totalAmount} ريال</span>
      </div>
      <div style="display:flex; flex-direction:column; gap:8px; margin-top:4px;">
        <label style="font-size:0.82rem; font-weight:700; color:var(--roast-brown);">تحديث حالة الفاتورة (تظهر للعميل فوراً):</label>
        <div class="input-glass-wrap">
          <i class="ri-refresh-line"></i>
          <select class="status-select">${statusOptions}</select>
        </div>
        <a href="https://wa.me/${customerPhone}?text=${waUpdateMsg}" target="_blank" class="whatsapp-btn">
          <i class="ri-whatsapp-line"></i>
          <span>إشعار العميل عبر واتساب</span>
        </a>
      </div>
    `;

    card.querySelector(".status-select").addEventListener("change", async (e) => {
      const newStatus = e.target.value;
      try {
        await updateDoc(doc(db, "nafal_orders", order.id), {
          status: newStatus,
          updatedAt: Date.now()
        });
        showToast(`تم تحديث الفاتورة #${order.invoiceNumber} إلى: ${newStatus}`);
      } catch (err) {
        handleFirebaseError(err, "تحديث حالة الفاتورة");
      }
    });

    container.appendChild(card);
  });
}

// 10. إدارة مفاتيح Firebase و ImgBB وتوليد الكود
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

document.getElementById("keysConfigForm").addEventListener("submit", (e) => {
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
  showToast("تم حفظ المفاتيح، جاري إعادة تشغيل الاتصال...");
  setTimeout(() => window.location.reload(), 800);
});

document.getElementById("resetDefaultKeysBtn").addEventListener("click", () => {
  localStorage.removeItem("nafal_fb_config");
  localStorage.removeItem("nafal_imgbb_key");
  showToast("تمت استعادة مفاتيحك الافتراضية، جاري التحديث...");
  setTimeout(() => window.location.reload(), 800);
});

// تشغيل غرفة العمليات
populateKeysForm();
initFirebaseConnection();
