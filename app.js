import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { 
  initializeFirestore, getFirestore, collection, doc, setDoc, getDoc, addDoc, updateDoc, deleteDoc, onSnapshot 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// 1. مفاتيح الربط الثابتة الخاصة بك (مدمجة تلقائياً بدون إزعاج في الإعدادات)
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAtCSiIDDN9nceKMj2xZbjREy9qXFEv68k",
  authDomain: "rawi-ye02.firebaseapp.com",
  projectId: "rawi-ye02",
  storageBucket: "rawi-ye02.firebasestorage.app",
  messagingSenderId: "247996335759",
  appId: "1:247996335759:web:846f6e93f75175bddc92fa",
  measurementId: "G-0RDKKNKSJJ"
};

const IMGBB_API_KEY = "0fbdc2c45d1d7098137c923129bd25b7";
const DEFAULT_COFFEE_IMG = "https://images.unsplash.com/photo-1559056199-641a0ac8b55e?auto=format&fit=crop&w=800&q=80";

let db = null;
let currentCategories = ["محاصيل مختصة", "أدوات قهوة", "بكجات نفال"];
let allOrders = [];
let selectedOrderStatusFilter = "all";

// قائمة حالات الطلب الاحترافية مع أيقوناتها وألوانها (مخصصة لوضوح وسهولة الاستخدام)
const ORDER_STATUS_LIST = [
  { value: "جديد - قيد المراجعة", icon: "ri-time-fill", cssClass: "status-new" },
  { value: "جاري التحميص والتجهيز", icon: "ri-fire-fill", cssClass: "status-prep" },
  { value: "مع المندوب للتوصيل", icon: "ri-e-bike-2-fill", cssClass: "status-ship" },
  { value: "تم التوصيل", icon: "ri-checkbox-circle-fill", cssClass: "status-done" },
  { value: "ملغي", icon: "ri-close-circle-fill", cssClass: "status-cancel" }
];

function getStatusMeta(statusValue) {
  return ORDER_STATUS_LIST.find(s => s.value === statusValue) || ORDER_STATUS_LIST[0];
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  document.getElementById("toastText").textContent = msg;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 3500);
}

// 2. تشخيص أخطاء القاعدة بوضوح
function handleFirebaseError(err, actionName = "") {
  console.error(`Firebase Error [${actionName}]:`, err);
  const dot = document.getElementById("dbStatusDot");
  const statusText = document.getElementById("dbStatusText");
  const diagBox = document.getElementById("diagnosticAlert");
  const diagTitle = document.getElementById("diagTitle");
  const diagDesc = document.getElementById("diagDesc");

  dot.classList.remove("online");
  dot.classList.add("error");

  const code = err.code || "";
  if (code.includes("permission-denied")) {
    statusText.textContent = "القاعدة مقفلة (Rules)";
    diagTitle.textContent = "السبب: قواعد الحماية (Rules) في حسابك بفايربيس مغلقة!";
    diagDesc.textContent = "الموقع متصل بمشروعك (rawi-ye02)، لكن فايربيس ترفض إضافة المنتجات أو الأقسام لأن القواعد مغلقة. فقط انسخ الكود بالأسفل وضعه في موقع Firebase Console داخل Firestore Database -> Rules واضغط Publish.";
    diagBox.classList.remove("hidden");
    showToast("يرجى فتح صلاحيات القاعدة (Rules) في فايربيس");
  } else {
    statusText.textContent = "تنبيه في الاتصال";
    showToast(`تعذر ${actionName}: تأكد من تفعيل Firestore Rules`);
  }
}

// 3. تهيئة الاتصال المستقر بفايربيس
function initFirebase() {
  try {
    let app;
    if (getApps().length === 0) {
      app = initializeApp(FIREBASE_CONFIG);
      db = initializeFirestore(app, {
        experimentalForceLongPolling: true,
        ignoreUndefinedProperties: true
      });
    } else {
      app = getApps()[0];
      db = getFirestore(app);
    }

    document.getElementById("dbStatusDot").classList.add("online");
    document.getElementById("dbStatusText").textContent = "متصل بالقاعدة";

    loadStoreSettings();
    listenToProducts();
    listenToOrders();
  } catch (err) {
    handleFirebaseError(err, "الاتصال بالقاعدة");
  }
}

document.getElementById("testDbBtn").addEventListener("click", async () => {
  showToast("جاري فحص الكتابة في قاعدة البيانات...");
  try {
    await setDoc(doc(db, "nafal_settings", "pingTest"), { lastCheck: Date.now() }, { merge: true });
    document.getElementById("diagnosticAlert").classList.add("hidden");
    document.getElementById("dbStatusDot").classList.remove("error");
    document.getElementById("dbStatusDot").classList.add("online");
    document.getElementById("dbStatusText").textContent = "القاعدة شغالة 100%";
    showToast("ممتاز! قاعدة البيانات تقبل الإضافة والحفظ فوراً");
  } catch (err) {
    handleFirebaseError(err, "فحص القاعدة");
  }
});

// 4. التنقل بين التبويبات والقوائم المنسدلة
document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  });
});

document.getElementById("toggleProductFormBtn").addEventListener("click", () => {
  document.getElementById("productFormAccordion").classList.toggle("open");
});

// 5. ضغط الصور بالمتصفح ورفعها إلى ImgBB (للمنتجات ولشعار المتجر)
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

async function uploadFileToImgBB(file) {
  const base64Image = await compressImage(file);
  const formData = new FormData();
  formData.append("image", base64Image);
  const response = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
    method: "POST",
    body: formData
  });
  const result = await response.json();
  if (result.success) {
    return result.data.display_url;
  }
  throw new Error("Upload failed");
}

// رفع صورة المنتج
document.getElementById("prodImageFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("uploadStatus");
  statusEl.textContent = "جاري ضغط ورفع صورة المنتج...";
  try {
    const url = await uploadFileToImgBB(file);
    document.getElementById("prodImageUrl").value = url;
    const preview = document.getElementById("prodImagePreview");
    preview.src = url;
    preview.classList.remove("hidden");
    statusEl.textContent = "تم رفع صورة المنتج بنجاح";
    showToast("تم رفع وتجهيز صورة المنتج");
  } catch (err) {
    console.error(err);
    statusEl.textContent = "تعذر رفع الصورة، حاول مرة أخرى";
  }
});

// رفع صورة شعار المتجر
document.getElementById("logoImageFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("logoUploadStatus");
  statusEl.textContent = "جاري ضغط ورفع شعار المتجر...";
  try {
    const url = await uploadFileToImgBB(file);
    document.getElementById("storeLogoUrlInput").value = url;
    const preview = document.getElementById("logoPreviewImg");
    preview.src = url;
    preview.classList.remove("hidden");
    statusEl.textContent = "تم رفع الشعار الجديد بنجاح! اضغط حفظ بالأسفل لاعتماده";
    showToast("تم رفع الشعار بنجاح");
  } catch (err) {
    console.error(err);
    statusEl.textContent = "حدث خطأ أثناء رفع الشعار";
  }
});

document.getElementById("clearLogoBtn").addEventListener("click", () => {
  document.getElementById("storeLogoUrlInput").value = "";
  document.getElementById("logoPreviewImg").classList.add("hidden");
  showToast("تم اختيار أيقونة القهوة الافتراضية، اضغط حفظ لاعتمادها");
});

// 6. إدارة المنتجات (إضافة / تعديل / حذف)
document.getElementById("productForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const saveBtn = document.getElementById("saveProductBtn");
  const editId = document.getElementById("editProductId").value.trim();

  const productData = {
    name: document.getElementById("prodName").value.trim(),
    category: document.getElementById("prodCategory").value || "محاصيل مختصة",
    price: Number(document.getElementById("prodPrice").value) || 0,
    stock: Number(document.getElementById("prodStock").value) || 0,
    description: document.getElementById("prodDesc").value.trim(),
    imageUrl: document.getElementById("prodImageUrl").value.trim() || DEFAULT_COFFEE_IMG,
    freeDelivery: document.getElementById("prodFreeDelivery").checked,
    updatedAt: Date.now()
  };

  saveBtn.disabled = true;
  saveBtn.innerHTML = `<i class="ri-loader-4-line spin-icon"></i><span>جاري الحفظ...</span>`;

  try {
    if (editId) {
      await updateDoc(doc(db, "nafal_products", editId), productData);
      showToast("تم تحديث المنتج بنجاح");
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
    saveBtn.innerHTML = `<i class="ri-save-3-line"></i><span>حفظ المنتج في المتجر</span>`;
  }
});

function resetProductForm() {
  document.getElementById("productForm").reset();
  document.getElementById("editProductId").value = "";
  document.getElementById("prodImagePreview").classList.add("hidden");
  document.getElementById("uploadStatus").textContent = "اضغط هنا لاختيار صورة المنتج من الجوال أو الكمبيوتر";
  document.getElementById("formAccordionTitle").textContent = "إضافة منتج أو محصول جديد للمتجر";
  document.getElementById("saveProductBtn").innerHTML = `<i class="ri-save-3-line"></i><span>حفظ المنتج في المتجر</span>`;
}

document.getElementById("resetProductFormBtn").addEventListener("click", resetProductForm);

function listenToProducts() {
  onSnapshot(collection(db, "nafal_products"), (snapshot) => {
    const container = document.getElementById("productsList");
    container.innerHTML = "";

    const items = [];
    snapshot.forEach(docSnap => {
      items.push({ id: docSnap.id, ...docSnap.data() });
    });

    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (items.length === 0) {
      container.innerHTML = `
        <div class="empty-box glass-panel">
          <i class="ri-cup-line"></i>
          <span>لا توجد منتجات حالياً. أضف أول محصول من الأعلى.</span>
        </div>
      `;
      return;
    }

    items.forEach(p => {
      const card = document.createElement("div");
      card.className = "product-card";
      card.innerHTML = `
        <img src="${p.imageUrl || DEFAULT_COFFEE_IMG}" alt="${p.name}">
        <div class="product-card-body">
          <div class="product-card-title">${p.name}</div>
          <div style="font-size:0.84rem; color:var(--text-secondary); font-weight:700;">${p.category} | المخزون: ${p.stock}</div>
          <div class="product-card-meta">
            <span>${p.price} ريال</span>
            <span style="font-size:0.78rem;">${p.freeDelivery ? "توصيل مجاني" : ""}</span>
          </div>
          <div class="product-card-actions">
            <button type="button" class="btn-glass edit-btn" style="flex:1; justify-content:center; padding:8px;">
              <i class="ri-edit-line"></i><span>تعديل</span>
            </button>
            <button type="button" class="btn-danger-glass del-btn" title="حذف المنتج">
              <i class="ri-delete-bin-line"></i>
            </button>
          </div>
        </div>
      `;

      card.querySelector(".edit-btn").addEventListener("click", () => {
        document.getElementById("productFormAccordion").classList.add("open");
        document.getElementById("formAccordionTitle").textContent = `تعديل المنتج: ${p.name}`;
        document.getElementById("editProductId").value = p.id;
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
        document.getElementById("saveProductBtn").innerHTML = `<i class="ri-check-line"></i><span>تحديث المنتج</span>`;
        window.scrollTo({ top: 0, behavior: "smooth" });
      });

      card.querySelector(".del-btn").addEventListener("click", async () => {
        if (confirm(`هل أنت متأكد من حذف "${p.name}"؟`)) {
          try {
            await deleteDoc(doc(db, "nafal_products", p.id));
            showToast("تم حذف المنتج");
          } catch (err) {
            handleFirebaseError(err, "حذف المنتج");
          }
        }
      });

      container.appendChild(card);
    });
  }, (err) => {
    handleFirebaseError(err, "جلب المنتجات");
  });
}

// 7. إدارة الفواتير والطلبات بالقوائم المنسدلة الكبيرة والواضحة (لأجل أم أنور)
function listenToOrders() {
  onSnapshot(collection(db, "nafal_orders"), (snapshot) => {
    allOrders = [];
    snapshot.forEach(docSnap => {
      allOrders.push({ id: docSnap.id, ...docSnap.data() });
    });

    allOrders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const newCount = allOrders.filter(o => o.status === "جديد - قيد المراجعة").length;
    document.getElementById("ordersBadge").textContent = newCount;

    renderOrdersAccordion();
  }, (err) => {
    handleFirebaseError(err, "جلب الفواتير");
  });
}

document.querySelectorAll("#orderFilterBar .filter-pill").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#orderFilterBar .filter-pill").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedOrderStatusFilter = btn.dataset.status;
    renderOrdersAccordion();
  });
});

function renderOrdersAccordion() {
  const container = document.getElementById("ordersAccordionList");
  container.innerHTML = "";

  const filtered = selectedOrderStatusFilter === "all"
    ? allOrders
    : allOrders.filter(o => o.status === selectedOrderStatusFilter);

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-box glass-panel">
        <i class="ri-inbox-2-line"></i>
        <span>لا توجد فواتير في هذا التصنيف حالياً</span>
      </div>
    `;
    return;
  }

  filtered.forEach((order, index) => {
    const statusMeta = getStatusMeta(order.status);
    const accordion = document.createElement("div");
    // فتح أول فاتورة تلقائياً إذا كانت جديدة للتسهيل
    accordion.className = `invoice-accordion glass-panel ${index === 0 && order.status === "جديد - قيد المراجعة" ? "open" : ""}`;

    const itemsHtml = (order.items || []).map(i => `• <strong>${i.name}</strong> (الكمية: ${i.qty} × ${i.price} ريال)`).join("<br>");
    const customerPhone = (order.customerPhone || "").replace(/[^0-9]/g, "");
    const waUpdateMsg = encodeURIComponent(
      `مرحباً ${order.customerName}\nتحديث بخصوص فاتورتك رقم (#${order.invoiceNumber}) في متجر نفال للقهوة المختصة:\nحالة طلبك الآن: *${order.status}*\nالإجمالي: ${order.totalAmount} ريال.`
    );

    const statusOptionsButtonsHtml = ORDER_STATUS_LIST.map(st => `
      <button type="button" class="status-option-btn ${order.status === st.value ? 'selected' : ''}" data-val="${st.value}">
        <div class="opt-main">
          <i class="${st.icon}"></i>
          <span>${st.value}</span>
        </div>
        <i class="${order.status === st.value ? 'ri-check-double-line' : 'ri-arrow-left-s-line'}"></i>
      </button>
    `).join("");

    accordion.innerHTML = `
      <!-- الشريط العلوي المختصر للفاتورة (يفتح ويقفل بالضغط) -->
      <button type="button" class="invoice-summary-bar">
        <div class="invoice-summary-right">
          <div class="expand-circle">
            <i class="ri-arrow-down-s-line"></i>
          </div>
          <div>
            <div class="inv-number-title">
              <i class="ri-receipt-line" style="color:var(--caramel);"></i>
              <span>فاتورة #${order.invoiceNumber}</span>
            </div>
            <div class="inv-customer-brief">${order.customerName} — ${order.customerPhone}</div>
            <div class="inv-time-brief">${new Date(order.createdAt || Date.now()).toLocaleString("ar-SA")}</div>
          </div>
        </div>

        <div class="invoice-summary-left">
          <span class="inv-total-badge">${order.totalAmount} ريال</span>
          <span class="status-badge-lg ${statusMeta.cssClass}">
            <i class="${statusMeta.icon}"></i>
            <span>${order.status}</span>
          </span>
        </div>
      </button>

      <!-- التفاصيل المنسدلة للفاتورة -->
      <div class="invoice-details-body">
        
        <!-- القائمة المنسدلة الكبيرة لتغيير حالة الطلب -->
        <div class="status-control-section">
          <div class="status-control-label">
            <i class="ri-exchange-box-line" style="color:var(--caramel); font-size:1.3rem;"></i>
            <span>اضغط هنا لتغيير حالة الطلب (تظهر للعميل فوراً):</span>
          </div>

          <div class="status-dropdown-wrapper">
            <button type="button" class="status-dropdown-trigger">
              <span>الحالة الحالية: ${order.status}</span>
              <i class="ri-arrow-down-s-fill trigger-left-icon"></i>
            </button>
            <div class="status-dropdown-menu">
              ${statusOptionsButtonsHtml}
            </div>
          </div>
        </div>

        <div class="inv-info-grid">
          <div class="inv-box glass-inset">
            <h4><i class="ri-user-location-line"></i> بيانات العميل والتوصيل</h4>
            <div><strong>الاسم:</strong> ${order.customerName}</div>
            <div><strong>الجوال:</strong> <a href="tel:${order.customerPhone}" style="color:var(--espresso); font-weight:900;">${order.customerPhone}</a></div>
            <div><strong>العنوان:</strong> ${order.customerAddress || "داخل شرورة"}</div>
          </div>

          <div class="inv-box glass-inset">
            <h4><i class="ri-cup-line"></i> المنتجات المطلوبة</h4>
            <div>${itemsHtml}</div>
            <div style="margin-top:8px; padding-top:8px; border-top:1px dashed rgba(30,19,13,0.15); font-weight:900;">
              رسوم التوصيل: ${order.deliveryFee} ريال | الإجمالي: ${order.totalAmount} ريال
            </div>
          </div>
        </div>

        <div class="inv-actions-row">
          <a href="https://wa.me/${customerPhone}?text=${waUpdateMsg}" target="_blank" class="whatsapp-btn-lg">
            <i class="ri-whatsapp-line"></i>
            <span>إرسال تحديث الفاتورة للعميل عبر واتساب</span>
          </a>
          ${order.gpsLocation ? `
            <a href="${order.gpsLocation}" target="_blank" class="gps-btn-lg">
              <i class="ri-map-pin-2-fill"></i>
              <span>فتح موقع العميل (GPS)</span>
            </a>
          ` : ""}
          <button type="button" class="btn-danger-glass del-order-btn">
            <i class="ri-delete-bin-line"></i>
            <span>حذف الفاتورة</span>
          </button>
        </div>

      </div>
    `;

    // فتح وقفل الفاتورة المنسدلة
    accordion.querySelector(".invoice-summary-bar").addEventListener("click", () => {
      accordion.classList.toggle("open");
    });

    // فتح وقفل القائمة المنسدلة لحالة الطلب
    const dropdownWrap = accordion.querySelector(".status-dropdown-wrapper");
    accordion.querySelector(".status-dropdown-trigger").addEventListener("click", () => {
      dropdownWrap.classList.toggle("open");
    });

    // اختيار حالة جديدة للطلب
    accordion.querySelectorAll(".status-option-btn").forEach(optBtn => {
      optBtn.addEventListener("click", async () => {
        const newStatus = optBtn.dataset.val;
        dropdownWrap.classList.remove("open");
        try {
          await updateDoc(doc(db, "nafal_orders", order.id), {
            status: newStatus,
            updatedAt: Date.now()
          });
          showToast(`تم تحديث الفاتورة #${order.invoiceNumber} إلى: ${newStatus}`);
        } catch (err) {
          handleFirebaseError(err, "تحديث حالة الطلب");
        }
      });
    });

    // حذف الفاتورة
    accordion.querySelector(".del-order-btn").addEventListener("click", async () => {
      if (confirm(`هل أنت متأكد من حذف الفاتورة #${order.invoiceNumber} نهائياً؟`)) {
        try {
          await deleteDoc(doc(db, "nafal_orders", order.id));
          showToast("تم حذف الفاتورة");
        } catch (err) {
          handleFirebaseError(err, "حذف الفاتورة");
        }
      }
    });

    container.appendChild(accordion);
  });
}

// 8. تحميل وحفظ الإعدادات، الهوية، الشعار، العروض، والأقسام
async function loadStoreSettings() {
  try {
    const docRef = doc(db, "nafal_settings", "storeConfig");
    const snap = await getDoc(docRef);

    if (snap.exists()) {
      const data = snap.data();
      applyHeaderIdentity(data);

      // العروض والتوصيل
      document.getElementById("bannerText").value = data.bannerText || "المتجر يوصل لداخل شرورة فقط";
      document.getElementById("promoMessage").value = data.promoMessage || "اطلب بـ 100 ريال والتوصيل بـ 5 ريال! وعند الطلب بـ 300 ريال التوصيل مجاني!";
      document.getElementById("baseDeliveryFee").value = data.baseDeliveryFee ?? 15;
      document.getElementById("enableSmartOffers").checked = data.enableSmartOffers ?? true;
      document.getElementById("tier1Threshold").value = data.tier1Threshold ?? 100;
      document.getElementById("tier1Fee").value = data.tier1Fee ?? 5;
      document.getElementById("tier2Threshold").value = data.tier2Threshold ?? 300;
      document.getElementById("tier2Fee").value = data.tier2Fee ?? 0;

      // الهوية والشعار والتواصل
      document.getElementById("storeNameInput").value = data.storeName || "NAFAL Specialty Roast";
      document.getElementById("storeDescInput").value = data.storeDescription || "نفال للقهوة المختصة والمحاصيل الفاخرة";
      document.getElementById("storeLogoUrlInput").value = data.storeLogo || "";
      if (data.storeLogo) {
        const preview = document.getElementById("logoPreviewImg");
        preview.src = data.storeLogo;
        preview.classList.remove("hidden");
      }

      document.getElementById("whatsappNumberInput").value = data.whatsappNumber || "";
      document.getElementById("snapchatUrlInput").value = data.snapchatUrl || "";
      document.getElementById("tiktokUrlInput").value = data.tiktokUrl || "";
      document.getElementById("instagramUrlInput").value = data.instagramUrl || "";
      document.getElementById("twitterUrlInput").value = data.twitterUrl || "";
      document.getElementById("mapsUrlInput").value = data.mapsUrl || "";

      if (Array.isArray(data.categories) && data.categories.length > 0) {
        currentCategories = data.categories;
      }
      renderCategories();
    } else {
      const defaultData = {
        storeName: "NAFAL Specialty Roast",
        storeDescription: "نفال للقهوة المختصة والمحاصيل الفاخرة",
        storeLogo: "",
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
        instagramUrl: "",
        twitterUrl: "",
        mapsUrl: "",
        categories: currentCategories
      };
      await setDoc(docRef, defaultData);
      applyHeaderIdentity(defaultData);
      renderCategories();
    }
  } catch (err) {
    renderCategories();
    handleFirebaseError(err, "تحميل الإعدادات");
  }
}

function applyHeaderIdentity(data) {
  if (data.storeName) {
    document.getElementById("headerStoreName").textContent = data.storeName;
  }
  if (data.storeDescription) {
    document.getElementById("headerStoreDesc").textContent = data.storeDescription;
  }
  const logoImg = document.getElementById("headerLogoImg");
  const logoIcon = document.getElementById("headerLogoIcon");
  if (data.storeLogo) {
    logoImg.src = data.storeLogo;
    logoImg.classList.remove("hidden");
    logoIcon.classList.add("hidden");
  } else {
    logoImg.classList.add("hidden");
    logoIcon.classList.remove("hidden");
  }
}

// حفظ العروض والتوصيل
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
    document.getElementById("diagnosticAlert").classList.add("hidden");
    showToast("تم حفظ إعدادات التوصيل والعروض بنجاح");
  } catch (err) {
    handleFirebaseError(err, "حفظ العروض");
  }
});

// حفظ الهوية والشعار وحسابات التواصل
document.getElementById("storeIdentityForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    storeName: document.getElementById("storeNameInput").value.trim(),
    storeDescription: document.getElementById("storeDescInput").value.trim(),
    storeLogo: document.getElementById("storeLogoUrlInput").value.trim(),
    whatsappNumber: document.getElementById("whatsappNumberInput").value.trim(),
    snapchatUrl: document.getElementById("snapchatUrlInput").value.trim(),
    tiktokUrl: document.getElementById("tiktokUrlInput").value.trim(),
    instagramUrl: document.getElementById("instagramUrlInput").value.trim(),
    twitterUrl: document.getElementById("twitterUrlInput").value.trim(),
    mapsUrl: document.getElementById("mapsUrlInput").value.trim()
  };

  try {
    await setDoc(doc(db, "nafal_settings", "storeConfig"), payload, { merge: true });
    applyHeaderIdentity(payload);
    document.getElementById("diagnosticAlert").classList.add("hidden");
    showToast("تم حفظ الشعار والهوية وحسابات التواصل بنجاح");
  } catch (err) {
    handleFirebaseError(err, "حفظ الهوية والتواصل");
  }
});

// 9. إدارة الأقسام
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
      <span><i class="ri-layout-grid-fill" style="color:var(--caramel); margin-left:8px;"></i>${cat}</span>
      <button type="button" class="btn-danger-glass" data-index="${index}">
        <i class="ri-delete-bin-line"></i><span>حذف</span>
      </button>
    `;

    li.querySelector("button").addEventListener("click", async () => {
      if (currentCategories.length <= 1) {
        showToast("يجب بقاء قسم واحد على الأقل في المتجر");
        return;
      }
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
  if (!val) {
    showToast("اكتب اسم القسم أولاً");
    return;
  }
  if (!currentCategories.includes(val)) {
    currentCategories.push(val);
    try {
      await setDoc(doc(db, "nafal_settings", "storeConfig"), { categories: currentCategories }, { merge: true });
      document.getElementById("diagnosticAlert").classList.add("hidden");
      renderCategories();
      input.value = "";
      showToast(`تمت إضافة قسم "${val}" بنجاح`);
    } catch (err) {
      currentCategories.pop();
      handleFirebaseError(err, "إضافة القسم");
    }
  } else {
    showToast("هذا القسم موجود مسبقاً");
  }
});

// تشغيل غرفة العمليات
initFirebase();
