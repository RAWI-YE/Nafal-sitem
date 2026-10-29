import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { 
  initializeFirestore, getFirestore, collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, onSnapshot, query, where 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// 1. إعدادات فايربيس ومفتاح رفع الصور الثابتة
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
const DEFAULT_PRODUCT_IMG = "https://images.unsplash.com/photo-1559056199-641a0ac8b55e?auto=format&fit=crop&w=800&q=80";

let app;
let db;
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

// متغيرات الجلسة الحالية والبيانات الحية
let currentSession = null; // { role: 'superadmin' | 'merchant' | 'staff', storeId, staffId, username, name, phone, staffRole }
let activeUnsubscribers = [];

// حالات الطلب المعتمدة مع الأيقونات والألوان
const ORDER_STATUS_LIST = [
  { value: "جديد - قيد المراجعة", icon: "ri-time-fill", cssClass: "status-new" },
  { value: "جاري التجهيز", icon: "ri-fire-fill", cssClass: "status-prep" },
  { value: "جاهز للمندوب", icon: "ri-archive-drawer-fill", cssClass: "status-prep" },
  { value: "مع المندوب للتوصيل", icon: "ri-e-bike-2-fill", cssClass: "status-ship" },
  { value: "تم التوصيل", icon: "ri-checkbox-circle-fill", cssClass: "status-done" },
  { value: "ملغي", icon: "ri-close-circle-fill", cssClass: "status-cancel" }
];

function getStatusMeta(statusVal) {
  return ORDER_STATUS_LIST.find(s => s.value === statusVal) || ORDER_STATUS_LIST[0];
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  document.getElementById("toastText").textContent = msg;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 3200);
}

function clearSubscriptions() {
  activeUnsubscribers.forEach(unsub => {
    if (typeof unsub === "function") unsub();
  });
  activeUnsubscribers = [];
}

// 2. ضغط ورفع الصور إلى ImgBB
function compressImage(file, maxWidth = 850, quality = 0.82) {
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

async function uploadImageToImgBB(file) {
  const base64 = await compressImage(file);
  const formData = new FormData();
  formData.append("image", base64);
  const res = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
    method: "POST",
    body: formData
  });
  const data = await res.json();
  if (data.success) return data.data.display_url;
  throw new Error("ImgBB Upload Failed");
}

// 3. تهيئة البيانات الأساسية للمنصة أول مرة (أبو تركي + إعدادات السوق)
async function ensurePlatformInitialized() {
  try {
    // 1. حساب الإدارة العليا الافتراضي
    const adminRef = doc(db, "nafal_platform", "superAdmin");
    const adminSnap = await getDoc(adminRef);
    if (!adminSnap.exists()) {
      await setDoc(adminRef, {
        username: "abuturki",
        password: "Nafal@2026",
        updatedAt: Date.now()
      });
    }

    // 2. إعدادات السوق الشعبي العامة
    const configRef = doc(db, "nafal_platform", "marketConfig");
    const configSnap = await getDoc(configRef);
    if (!configSnap.exists()) {
      await setDoc(configRef, {
        showMarketplace: true,
        platformName: "سوق نفال — شرورة",
        platformSlogan: "ارحبوا في سوق نفال.. كل متاجر وأسر شرورة بين يديك!",
        platformBanner: "التوصيل والخدمة مخصصة لأهلنا داخل شرورة فقط",
        platformLogo: "",
        marketCategories: ["متاجر القهوة والمحامص", "الأسر المنتجة والحلى", "العسل والسمن والتمور", "العطور والبخور", "متاجر متنوعة"]
      });
    }
    document.getElementById("diagnosticAlert").classList.add("hidden");
  } catch (err) {
    console.error("Init Error:", err);
    if ((err.code || "").includes("permission-denied")) {
      document.getElementById("diagnosticAlert").classList.remove("hidden");
    }
  }
}

// 4. نظام البوابة الذكية لتسجيل الدخول والتوجيه حسب الصلاحية
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const userIn = document.getElementById("loginUsername").value.trim();
  const passIn = document.getElementById("loginPassword").value.trim();
  const btn = document.getElementById("loginSubmitBtn");

  btn.disabled = true;
  btn.innerHTML = `<i class="ri-loader-4-line"></i><span>جاري التحقق من الصلاحية...</span>`;

  try {
    await ensurePlatformInitialized();

    // فحص 1: هل هو الإدارة العليا (أبو تركي)؟
    const adminSnap = await getDoc(doc(db, "nafal_platform", "superAdmin"));
    if (adminSnap.exists()) {
      const adminData = adminSnap.data();
      if (adminData.username.toLowerCase() === userIn.toLowerCase() && adminData.password === passIn) {
        startSession({
          role: "superadmin",
          username: adminData.username,
          name: "الإدارة العليا (أبو تركي)"
        });
        return;
      }
    }

    // فحص 2: هل هو تاجر (صاحب متجر)؟
    const storesSnap = await getDocs(collection(db, "nafal_stores"));
    let matchedStore = null;
    storesSnap.forEach(docSnap => {
      const st = docSnap.data();
      if ((st.merchantUsername || "").toLowerCase() === userIn.toLowerCase() && st.merchantPassword === passIn) {
        matchedStore = { id: docSnap.id, ...st };
      }
    });

    if (matchedStore) {
      startSession({
        role: "merchant",
        storeId: matchedStore.id,
        username: matchedStore.merchantUsername,
        name: matchedStore.name
      });
      return;
    }

    // فحص 3: هل هو موظف أو مندوب توصيل؟
    const staffSnap = await getDocs(collection(db, "nafal_staff"));
    let matchedStaff = null;
    staffSnap.forEach(docSnap => {
      const sf = docSnap.data();
      if ((sf.username || "").toLowerCase() === userIn.toLowerCase() && sf.password === passIn) {
        matchedStaff = { id: docSnap.id, ...sf };
      }
    });

    if (matchedStaff) {
      startSession({
        role: "staff",
        staffId: matchedStaff.id,
        storeId: matchedStaff.storeId,
        username: matchedStaff.username,
        name: matchedStaff.name,
        phone: matchedStaff.phone || "",
        staffRole: matchedStaff.role || "مندوب توصيل"
      });
      return;
    }

    showToast("اسم المستخدم أو كلمة المرور غير صحيحة");
  } catch (err) {
    console.error("Login Error:", err);
    showToast("حدث خطأ في الاتصال بقاعدة البيانات");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="ri-login-circle-line"></i><span>دخول للبوابة الذكية</span>`;
  }
});

function startSession(sessionData) {
  currentSession = sessionData;
  localStorage.setItem("nafal_portal_session", JSON.stringify(sessionData));

  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("portalApp").classList.remove("hidden");

  document.getElementById("superAdminView").classList.add("hidden");
  document.getElementById("merchantView").classList.add("hidden");
  document.getElementById("staffView").classList.add("hidden");

  clearSubscriptions();

  if (sessionData.role === "superadmin") {
    document.getElementById("roleBadge").textContent = "الإدارة العليا";
    document.getElementById("portalTitle").textContent = "البوابة الذكية — نفال";
    document.getElementById("portalSubtitle").textContent = "إدارة السوق الشعبي، التجار، والاشتراكات — شرورة";
    document.getElementById("currentUserDisplay").textContent = sessionData.username;
    document.getElementById("superAdminView").classList.remove("hidden");
    initSuperAdminPortal();
  } else if (sessionData.role === "merchant") {
    document.getElementById("roleBadge").textContent = "لوحة التاجر";
    document.getElementById("currentUserDisplay").textContent = sessionData.username;
    document.getElementById("merchantView").classList.remove("hidden");
    initMerchantPortal(sessionData.storeId);
  } else if (sessionData.role === "staff") {
    document.getElementById("roleBadge").textContent = sessionData.staffRole;
    document.getElementById("currentUserDisplay").textContent = sessionData.name;
    document.getElementById("staffView").classList.remove("hidden");
    initStaffPortal(sessionData);
  }
}

document.getElementById("logoutBtn").addEventListener("click", () => {
  clearSubscriptions();
  currentSession = null;
  localStorage.removeItem("nafal_portal_session");
  document.getElementById("portalApp").classList.add("hidden");
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("loginForm").reset();
  showToast("تم تسجيل الخروج بنجاح");
});

// تفعيل أزرار التنقل للتبويبات
function setupTabNavigation(navBarId, viewContainerId) {
  const navBar = document.getElementById(navBarId);
  const viewContainer = document.getElementById(viewContainerId);
  if (!navBar || !viewContainer) return;

  navBar.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      navBar.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
      viewContainer.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      const target = document.getElementById(btn.dataset.tab);
      if (target) target.classList.add("active");
    });
  });
}

setupTabNavigation("saNavBar", "superAdminView");
setupTabNavigation("mNavBar", "merchantView");

// ============================================================================
// القسم الأول: منطق الإدارة العليا (Super Admin - أبو تركي)
// ============================================================================
let saMarketCategories = ["متاجر القهوة والمحامص", "الأسر المنتجة والحلى", "العسل والسمن والتمور", "العطور والبخور", "متاجر متنوعة"];
let saAllStores = [];
let saAllProducts = [];
let saAllOrders = [];

function initSuperAdminPortal() {
  // تحديد تاريخ افتراضي لانتهاء الاشتراك بعد شهر
  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  document.getElementById("saSubExpiry").value = nextMonth.toISOString().split("T")[0];

  // جلب بيانات دخول الأدمن الأعلى
  getDoc(doc(db, "nafal_platform", "superAdmin")).then(snap => {
    if (snap.exists()) {
      document.getElementById("saAdminNewUser").value = snap.data().username || "abuturki";
      document.getElementById("saAdminNewPass").value = snap.data().password || "";
    }
  });

  // الاستماع لإعدادات المنصة
  const unsubConfig = onSnapshot(doc(db, "nafal_platform", "marketConfig"), snap => {
    if (snap.exists()) {
      const d = snap.data();
      document.getElementById("saShowMarketplaceToggle").checked = d.showMarketplace ?? true;
      document.getElementById("saPlatformName").value = d.platformName || "سوق نفال — شرورة";
      document.getElementById("saPlatformSlogan").value = d.platformSlogan || "";
      document.getElementById("saPlatformBanner").value = d.platformBanner || "";
      document.getElementById("saPlatformLogoUrl").value = d.platformLogo || "";
      if (Array.isArray(d.marketCategories) && d.marketCategories.length > 0) {
        saMarketCategories = d.marketCategories;
      }
      renderSaMarketCategories();
    }
  });

  // الاستماع للمتاجر
  const unsubStores = onSnapshot(collection(db, "nafal_stores"), snap => {
    saAllStores = [];
    snap.forEach(d => saAllStores.push({ id: d.id, ...d.data() }));
    saAllStores.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    updateSaStatsAndStoresUI();
  });

  // الاستماع للمنتجات لحساب عدد منتجات كل تاجر
  const unsubProds = onSnapshot(collection(db, "nafal_products"), snap => {
    saAllProducts = [];
    snap.forEach(d => saAllProducts.push({ id: d.id, ...d.data() }));
    updateSaStatsAndStoresUI();
  });

  // الاستماع للفواتير
  const unsubOrders = onSnapshot(collection(db, "nafal_orders"), snap => {
    saAllOrders = [];
    snap.forEach(d => saAllOrders.push({ id: d.id, ...d.data() }));
    document.getElementById("saStatTotalOrders").textContent = saAllOrders.length;
    updateSaStatsAndStoresUI();
  });

  // الاستماع لطلبات تغيير أسماء المتاجر
  const unsubNameReqs = onSnapshot(collection(db, "nafal_name_requests"), snap => {
    const reqs = [];
    snap.forEach(d => reqs.push({ id: d.id, ...d.data() }));
    reqs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const pendingReqs = reqs.filter(r => r.status === "pending");
    document.getElementById("saStatPendingNames").textContent = pendingReqs.length;
    document.getElementById("saRequestsBadge").textContent = pendingReqs.length;
    renderSaNameRequests(reqs);
  });

  activeUnsubscribers.push(unsubConfig, unsubStores, unsubProds, unsubOrders, unsubNameReqs);
}

document.getElementById("toggleSaStoreFormBtn").addEventListener("click", () => {
  document.getElementById("saStoreFormAccordion").classList.toggle("open");
});

function renderSaMarketCategories() {
  const select = document.getElementById("saStoreCategory");
  const list = document.getElementById("saMarketCategoriesList");
  select.innerHTML = "";
  list.innerHTML = "";

  saMarketCategories.forEach((cat, idx) => {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    select.appendChild(opt);

    const li = document.createElement("li");
    li.className = "cat-item glass-inset";
    li.innerHTML = `
      <span><i class="ri-store-2-line" style="color:var(--caramel); margin-left:8px;"></i>${cat}</span>
      <button type="button" class="btn-danger-glass"><i class="ri-delete-bin-line"></i></button>
    `;
    li.querySelector("button").addEventListener("click", async () => {
      if (saMarketCategories.length <= 1) return showToast("يجب بقاء تصنيف واحد على الأقل");
      saMarketCategories.splice(idx, 1);
      await setDoc(doc(db, "nafal_platform", "marketConfig"), { marketCategories: saMarketCategories }, { merge: true });
      showToast("تم حذف التصنيف");
    });
    list.appendChild(li);
  });
}

document.getElementById("saAddMarketCatBtn").addEventListener("click", async () => {
  const input = document.getElementById("saNewMarketCatInput");
  const val = input.value.trim();
  if (!val) return;
  if (!saMarketCategories.includes(val)) {
    saMarketCategories.push(val);
    await setDoc(doc(db, "nafal_platform", "marketConfig"), { marketCategories: saMarketCategories }, { merge: true });
    input.value = "";
    showToast("تمت إضافة تصنيف السوق");
  }
});

// حفظ أو تعديل متجر وتاجر من الإدارة العليا
document.getElementById("saStoreForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const editId = document.getElementById("saEditStoreId").value.trim();
  const prefix = document.getElementById("saStorePrefix").value.trim().toUpperCase() || "NF";

  const storePayload = {
    name: document.getElementById("saStoreName").value.trim(),
    marketCategory: document.getElementById("saStoreCategory").value,
    invoicePrefix: prefix,
    whatsappNumber: document.getElementById("saStoreWhatsapp").value.trim(),
    merchantUsername: document.getElementById("saMerchantUsername").value.trim(),
    merchantPassword: document.getElementById("saMerchantPassword").value.trim(),
    subPlan: document.getElementById("saSubPlan").value,
    subPrice: Number(document.getElementById("saSubPrice").value) || 0,
    subExpiry: document.getElementById("saSubExpiry").value,
    storeStatus: document.getElementById("saStoreStatus").value,
    updatedAt: Date.now()
  };

  try {
    if (editId) {
      await updateDoc(doc(db, "nafal_stores", editId), storePayload);
      showToast("تم تحديث بيانات المتجر والاشتراك بنجاح");
    } else {
      storePayload.createdAt = Date.now();
      storePayload.description = "متجر معتمد في سوق نفال — شرورة";
      storePayload.logo = "";
      storePayload.workMode = "24h";
      storePayload.openTime = "08:00";
      storePayload.closeTime = "23:30";
      storePayload.minOrderAmount = 0;
      storePayload.baseDeliveryFee = 15;
      storePayload.enableSmartOffers = true;
      storePayload.promoMessage = "اطلب بـ 100 ريال والتوصيل بـ 5 ريال! وعند الطلب بـ 300 ريال التوصيل مجاني!";
      storePayload.tier1Threshold = 100;
      storePayload.tier1Fee = 5;
      storePayload.tier2Threshold = 300;
      storePayload.tier2Fee = 0;
      storePayload.categories = ["المنتجات المميزة", "بكجات وعروض", "أصناف متنوعة"];
      storePayload.ratingSum = 5;
      storePayload.ratingCount = 1;
      await addDoc(collection(db, "nafal_stores"), storePayload);
      showToast("تم تأسيس المتجر وإنشاء حساب التاجر بنجاح");
    }
    resetSaStoreForm();
  } catch (err) {
    console.error(err);
    showToast("حدث خطأ أثناء حفظ المتجر");
  }
});

function resetSaStoreForm() {
  document.getElementById("saStoreForm").reset();
  document.getElementById("saEditStoreId").value = "";
  document.getElementById("saStoreFormTitle").textContent = "تأسيس متجر جديد ومنح صلاحية لتاجر";
  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  document.getElementById("saSubExpiry").value = nextMonth.toISOString().split("T")[0];
}

document.getElementById("saResetStoreFormBtn").addEventListener("click", resetSaStoreForm);

function updateSaStatsAndStoresUI() {
  const todayStr = new Date().toISOString().split("T")[0];
  const activeCount = saAllStores.filter(s => s.storeStatus === "active" && (!s.subExpiry || s.subExpiry >= todayStr)).length;

  document.getElementById("saStatTotalStores").textContent = saAllStores.length;
  document.getElementById("saStatActiveStores").textContent = activeCount;

  const container = document.getElementById("saStoresAccordionList");
  container.innerHTML = "";

  if (saAllStores.length === 0) {
    container.innerHTML = `
      <div class="empty-box glass-panel">
        <i class="ri-store-2-line"></i>
        <span>لا توجد متاجر مسجلة حالياً. أنشئ أول متجر من النموذج أعلاه.</span>
      </div>
    `;
    return;
  }

  saAllStores.forEach(st => {
    const isExpired = st.subExpiry && st.subExpiry < todayStr;
    const isMaintenance = st.storeStatus === "maintenance" || isExpired;
    const storeProdsCount = saAllProducts.filter(p => p.storeId === st.id).length;
    const storeOrdersCount = saAllOrders.filter(o => o.storeId === st.id).length;

    const card = document.createElement("div");
    card.className = "invoice-accordion glass-panel";
    card.innerHTML = `
      <button type="button" class="invoice-summary-bar">
        <div class="invoice-summary-right">
          <div class="expand-circle"><i class="ri-arrow-down-s-line"></i></div>
          <div>
            <div class="inv-number-title">
              <i class="ri-store-3-fill" style="color:var(--caramel);"></i>
              <span>${st.name}</span>
              <small style="color:var(--text-secondary); font-size:0.85rem;">(رمز الفواتير: #${st.invoicePrefix || "NF"})</small>
            </div>
            <div class="inv-customer-brief">التصنيف: ${st.marketCategory || "عام"} | الأدمن: <span dir="ltr">${st.merchantUsername}</span></div>
            <div class="inv-time-brief">المنتجات: ${storeProdsCount} منتج | الطلبات: ${storeOrdersCount} فاتورة</div>
          </div>
        </div>

        <div class="invoice-summary-left">
          <span class="inv-total-badge">${st.subPlan || "مجاني"} (${st.subPrice || 0} ريال)</span>
          <span class="status-badge-lg ${isMaintenance ? 'status-cancel' : 'status-done'}">
            <i class="${isMaintenance ? 'ri-tools-fill' : 'ri-checkbox-circle-fill'}"></i>
            <span>${isMaintenance ? "تحت الصيانة / منتهي" : "نشط ومفعل"}</span>
          </span>
        </div>
      </button>

      <div class="invoice-details-body">
        <div class="inv-info-grid">
          <div class="inv-box glass-inset">
            <h4><i class="ri-key-2-line"></i> بيانات دخول التاجر والتواصل</h4>
            <div><strong>اسم المستخدم (الأدمن):</strong> <span dir="ltr">${st.merchantUsername}</span></div>
            <div><strong>كلمة المرور:</strong> <span dir="ltr">${st.merchantPassword}</span></div>
            <div><strong>واتساب المتجر:</strong> <span dir="ltr">${st.whatsappNumber}</span></div>
          </div>

          <div class="inv-box glass-inset">
            <h4><i class="ri-vip-crown-line"></i> تفاصيل الاشتراك</h4>
            <div><strong>نوع الباقة:</strong> ${st.subPlan} (${st.subPrice || 0} ريال)</div>
            <div><strong>تاريخ الانتهاء:</strong> ${st.subExpiry || "غير محدد"} ${isExpired ? '<strong style="color:var(--danger);">(منتهي)</strong>' : ''}</div>
            <div><strong>عدد المنتجات المرفوعة:</strong> ${storeProdsCount} منتج</div>
          </div>
        </div>

        <div class="inv-actions-row">
          <button type="button" class="btn-primary-glass edit-store-btn">
            <i class="ri-edit-2-line"></i>
            <span>تعديل المتجر / تجديد الاشتراك</span>
          </button>
          <button type="button" class="btn-glass toggle-maint-btn">
            <i class="ri-tools-line"></i>
            <span>${st.storeStatus === "maintenance" ? "تفعيل المتجر الآن" : "تحويل إلى تحت الصيانة"}</span>
          </button>
          <button type="button" class="btn-danger-glass del-store-btn">
            <i class="ri-delete-bin-line"></i>
            <span>حذف المتجر</span>
          </button>
        </div>
      </div>
    `;

    card.querySelector(".invoice-summary-bar").addEventListener("click", () => {
      card.classList.toggle("open");
    });

    card.querySelector(".edit-store-btn").addEventListener("click", () => {
      document.getElementById("saStoreFormAccordion").classList.add("open");
      document.getElementById("saStoreFormTitle").textContent = `تعديل متجر واشتراك: ${st.name}`;
      document.getElementById("saEditStoreId").value = st.id;
      document.getElementById("saStoreName").value = st.name;
      document.getElementById("saStoreCategory").value = st.marketCategory || saMarketCategories[0];
      document.getElementById("saStorePrefix").value = st.invoicePrefix || "NF";
      document.getElementById("saStoreWhatsapp").value = st.whatsappNumber || "";
      document.getElementById("saMerchantUsername").value = st.merchantUsername || "";
      document.getElementById("saMerchantPassword").value = st.merchantPassword || "";
      document.getElementById("saSubPlan").value = st.subPlan || "مجاني";
      document.getElementById("saSubPrice").value = st.subPrice || 0;
      document.getElementById("saSubExpiry").value = st.subExpiry || "";
      document.getElementById("saStoreStatus").value = st.storeStatus || "active";
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    card.querySelector(".toggle-maint-btn").addEventListener("click", async () => {
      const nextStatus = st.storeStatus === "maintenance" ? "active" : "maintenance";
      await updateDoc(doc(db, "nafal_stores", st.id), { storeStatus: nextStatus });
      showToast(nextStatus === "active" ? "تم تفعيل المتجر في السوق" : "تم تحويل المتجر لوضع الصيانة");
    });

    card.querySelector(".del-store-btn").addEventListener("click", async () => {
      if (confirm(`هل أنت متأكد من حذف متجر "${st.name}"؟`)) {
        await deleteDoc(doc(db, "nafal_stores", st.id));
        showToast("تم حذف المتجر");
      }
    });

    container.appendChild(card);
  });
}

// مراجعة طلبات تغيير أسماء المتاجر
function renderSaNameRequests(requests) {
  const container = document.getElementById("saNameRequestsList");
  container.innerHTML = "";

  if (requests.length === 0) {
    container.innerHTML = `
      <div class="empty-box glass-panel">
        <i class="ri-shield-check-line"></i>
        <span>لا توجد طلبات لتغيير أسماء المتاجر حالياً</span>
      </div>
    `;
    return;
  }

  requests.forEach(req => {
    const isPending = req.status === "pending";
    const card = document.createElement("div");
    card.className = "glass-panel form-card";
    card.style.marginBottom = "12px";
    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
        <div>
          <div style="font-size:1.08rem; font-weight:900;">
            الاسم الحالي: <span style="color:var(--text-secondary);">${req.oldName}</span> 
            ⬅️ الاسم الجديد المطلوب: <span style="color:var(--caramel-dark);">${req.requestedName}</span>
          </div>
          <small class="sub-hint">تاريخ الطلب: ${new Date(req.createdAt).toLocaleString("ar-SA")}</small>
        </div>
        <div style="display:flex; gap:8px;">
          ${isPending ? `
            <button type="button" class="btn-primary-glass approve-btn"><i class="ri-check-line"></i> موافقة واعتماد الاسم</button>
            <button type="button" class="btn-danger-glass reject-btn"><i class="ri-close-line"></i> رفض</button>
          ` : `
            <span class="status-badge-lg ${req.status === 'approved' ? 'status-done' : 'status-cancel'}">
              ${req.status === 'approved' ? 'تمت الموافقة' : 'مرفوض'}
            </span>
          `}
        </div>
      </div>
    `;

    if (isPending) {
      card.querySelector(".approve-btn").addEventListener("click", async () => {
        await updateDoc(doc(db, "nafal_stores", req.storeId), { name: req.requestedName });
        await updateDoc(doc(db, "nafal_name_requests", req.id), { status: "approved", resolvedAt: Date.now() });
        showToast(`تم اعتماد الاسم الجديد: ${req.requestedName}`);
      });

      card.querySelector(".reject-btn").addEventListener("click", async () => {
        await updateDoc(doc(db, "nafal_name_requests", req.id), { status: "rejected", resolvedAt: Date.now() });
        showToast("تم رفض طلب تغيير الاسم");
      });
    }

    container.appendChild(card);
  });
}

// حفظ إعدادات المنصة العامة
document.getElementById("saPlatformLogoFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("saPlatformLogoStatus");
  statusEl.textContent = "جاري ضغط ورفع شعار المنصة...";
  try {
    const url = await uploadImageToImgBB(file);
    document.getElementById("saPlatformLogoUrl").value = url;
    statusEl.textContent = "تم رفع شعار المنصة بنجاح";
  } catch {
    statusEl.textContent = "تعذر رفع الشعار";
  }
});

document.getElementById("saPlatformForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await setDoc(doc(db, "nafal_platform", "marketConfig"), {
    showMarketplace: document.getElementById("saShowMarketplaceToggle").checked,
    platformName: document.getElementById("saPlatformName").value.trim(),
    platformSlogan: document.getElementById("saPlatformSlogan").value.trim(),
    platformBanner: document.getElementById("saPlatformBanner").value.trim(),
    platformLogo: document.getElementById("saPlatformLogoUrl").value.trim()
  }, { merge: true });
  showToast("تم حفظ إعدادات سوق شرورة والمنصة العامة");
});

// تحديث بيانات دخول الإدارة العليا (أبو تركي)
document.getElementById("saCredentialsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const newUser = document.getElementById("saAdminNewUser").value.trim();
  const newPass = document.getElementById("saAdminNewPass").value.trim();
  await setDoc(doc(db, "nafal_platform", "superAdmin"), {
    username: newUser,
    password: newPass,
    updatedAt: Date.now()
  });
  currentSession.username = newUser;
  localStorage.setItem("nafal_portal_session", JSON.stringify(currentSession));
  document.getElementById("currentUserDisplay").textContent = newUser;
  showToast("تم تحديث اسم المستخدم وكلمة المرور للإدارة العليا");
});

// ============================================================================
// القسم الثاني: منطق التاجر (Merchant View - صاحب المتجر)
// ============================================================================
let mCurrentStore = null;
let mStoreCategories = ["المنتجات المميزة", "بكجات وعروض", "أصناف متنوعة"];
let mUploadedImagesList = [];
let mAllOrders = [];
let mSelectedOrderFilter = "all";

function initMerchantPortal(storeId) {
  // 1. الاستماع لبيانات متجر التاجر
  const unsubStore = onSnapshot(doc(db, "nafal_stores", storeId), snap => {
    if (!snap.exists()) return;
    mCurrentStore = { id: snap.id, ...snap.data() };
    populateMerchantUI(mCurrentStore);
  });

  // 2. الاستماع لمنتجات هذا المتجر فقط
  const qProds = query(collection(db, "nafal_products"), where("storeId", "==", storeId));
  const unsubProds = onSnapshot(qProds, snap => {
    const prods = [];
    snap.forEach(d => prods.push({ id: d.id, ...d.data() }));
    prods.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    renderMerchantProducts(prods);
  });

  // 3. الاستماع لفواتير هذا المتجر فقط
  const qOrders = query(collection(db, "nafal_orders"), where("storeId", "==", storeId));
  const unsubOrders = onSnapshot(qOrders, snap => {
    mAllOrders = [];
    snap.forEach(d => mAllOrders.push({ id: d.id, ...d.data() }));
    mAllOrders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    updateMerchantStatsAndOrders();
  });

  // 4. الاستماع لموظفي ومناديب هذا المتجر فقط
  const qStaff = query(collection(db, "nafal_staff"), where("storeId", "==", storeId));
  const unsubStaff = onSnapshot(qStaff, snap => {
    const staffList = [];
    snap.forEach(d => staffList.push({ id: d.id, ...d.data() }));
    renderMerchantStaff(staffList);
  });

  activeUnsubscribers.push(unsubStore, unsubProds, unsubOrders, unsubStaff);
}

function populateMerchantUI(st) {
  document.getElementById("portalTitle").textContent = st.name;
  document.getElementById("portalSubtitle").textContent = st.description || "لوحة إدارة المتجر والطلبات — شرورة";

  const logoImg = document.getElementById("portalLogoImg");
  const logoIcon = document.getElementById("portalLogoIcon");
  if (st.logo) {
    logoImg.src = st.logo;
    logoImg.classList.remove("hidden");
    logoIcon.classList.add("hidden");
  } else {
    logoImg.classList.add("hidden");
    logoIcon.classList.remove("hidden");
  }

  // شريط الاشتراك
  const todayStr = new Date().toISOString().split("T")[0];
  const isExpired = st.subExpiry && st.subExpiry < todayStr;
  document.getElementById("mSubBannerTitle").textContent = 
    `باقة اشتراكك: ${st.subPlan || "مجاني"} (${st.subPrice ? st.subPrice + " ريال" : "مفعل"}) ${isExpired ? "— منتهي (المتجر في وضع الصيانة)" : ""}`;
  document.getElementById("mSubBannerExpiry").innerHTML = 
    `تاريخ الانتهاء: <strong>${st.subExpiry || "مفتوح"}</strong> | رمز فواتير متجرك: <strong>#${st.invoicePrefix || "NF"}</strong>`;

  // التقييم
  const avgRating = st.ratingCount ? (st.ratingSum / st.ratingCount).toFixed(1) : "5.0";
  document.getElementById("mStatRating").textContent = `${avgRating} ★`;

  // تعبئة حقول الدوام والعروض
  document.getElementById("mWorkMode").value = st.workMode || "24h";
  document.getElementById("mOpenTime").value = st.openTime || "08:00";
  document.getElementById("mCloseTime").value = st.closeTime || "23:30";
  document.getElementById("mInvoicePrefix").value = st.invoicePrefix || "NF";
  document.getElementById("mMinOrderAmount").value = st.minOrderAmount ?? 0;
  document.getElementById("mBaseDeliveryFee").value = st.baseDeliveryFee ?? 15;
  document.getElementById("mEnableSmartOffers").checked = st.enableSmartOffers ?? true;
  document.getElementById("mPromoMessage").value = st.promoMessage || "";
  document.getElementById("mTier1Threshold").value = st.tier1Threshold ?? 100;
  document.getElementById("mTier1Fee").value = st.tier1Fee ?? 5;
  document.getElementById("mTier2Threshold").value = st.tier2Threshold ?? 300;
  document.getElementById("mTier2Fee").value = st.tier2Fee ?? 0;

  // تعبئة الهوية والتواصل
  document.getElementById("mStoreDescInput").value = st.description || "";
  document.getElementById("mStoreLogoUrl").value = st.logo || "";
  if (st.logo) {
    const prev = document.getElementById("mLogoPreview");
    prev.src = st.logo;
    prev.classList.remove("hidden");
  }
  document.getElementById("mWhatsappInput").value = st.whatsappNumber || "";
  document.getElementById("mMapsUrlInput").value = st.mapsUrl || "";
  document.getElementById("mSnapInput").value = st.snapchatUrl || "";
  document.getElementById("mTiktokInput").value = st.tiktokUrl || "";
  document.getElementById("mInstaInput").value = st.instagramUrl || "";

  // بيانات دخول التاجر
  document.getElementById("mSelfNewUser").value = st.merchantUsername || "";
  document.getElementById("mSelfNewPass").value = st.merchantPassword || "";

  if (Array.isArray(st.categories) && st.categories.length > 0) {
    mStoreCategories = st.categories;
  }
  renderMerchantCategories();
}

// نسخ الرابط العميق الخاص بمتجر التاجر
document.getElementById("mCopyStoreLinkBtn").addEventListener("click", () => {
  if (!mCurrentStore) return;
  const link = `${window.location.origin}/?store=${mCurrentStore.id}`;
  navigator.clipboard.writeText(link).then(() => {
    showToast("تم نسخ رابط متجرك! ضعه في بايو السناب أو التيك توك");
  });
});

document.getElementById("toggleMProductFormBtn").addEventListener("click", () => {
  document.getElementById("mProductFormAccordion").classList.toggle("open");
});

// رفع حتى 4 صور للمنتج
document.getElementById("mProdImagesInput").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  if (mUploadedImagesList.length + files.length > 4) {
    showToast("الحد الأقصى المسموح هو 4 صور لكل منتج");
    return;
  }

  const statusEl = document.getElementById("mUploadStatus");
  statusEl.textContent = "جاري ضغط ورفع الصور...";

  try {
    for (const file of files) {
      if (mUploadedImagesList.length >= 4) break;
      const url = await uploadImageToImgBB(file);
      mUploadedImagesList.push(url);
    }
    renderMerchantUploadedThumbs();
    statusEl.textContent = `تم رفع ${mUploadedImagesList.length} من 4 صور بنجاح`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = "حدث خطأ أثناء رفع بعض الصور";
  }
});

function renderMerchantUploadedThumbs() {
  const row = document.getElementById("mImagesPreviewRow");
  row.innerHTML = "";
  mUploadedImagesList.forEach((url, idx) => {
    const box = document.createElement("div");
    box.className = "preview-thumb-box";
    box.innerHTML = `
      <img src="${url}" alt="صورة">
      <button type="button" title="حذف الصورة">&times;</button>
    `;
    box.querySelector("button").addEventListener("click", () => {
      mUploadedImagesList.splice(idx, 1);
      renderMerchantUploadedThumbs();
    });
    row.appendChild(box);
  });
}

// حفظ منتج أو بكج للتاجر
document.getElementById("mProductForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!mCurrentStore) return;

  const editId = document.getElementById("mEditProductId").value.trim();
  const images = mUploadedImagesList.length > 0 ? mUploadedImagesList : [DEFAULT_PRODUCT_IMG];

  const prodData = {
    storeId: mCurrentStore.id,
    storeName: mCurrentStore.name,
    name: document.getElementById("mProdName").value.trim(),
    productType: document.getElementById("mProdType").value,
    category: document.getElementById("mProdCategory").value,
    price: Number(document.getElementById("mProdPrice").value) || 0,
    oldPrice: Number(document.getElementById("mProdOldPrice").value) || 0,
    stock: Number(document.getElementById("mProdStock").value) || 0,
    weight: document.getElementById("mProdWeight").value.trim(),
    notes: document.getElementById("mProdNotes").value.trim(),
    description: document.getElementById("mProdDesc").value.trim(),
    fullDescription: document.getElementById("mProdDesc").value.trim(),
    imageUrl: images[0],
    images: images,
    freeDelivery: document.getElementById("mProdFreeDelivery").checked,
    updatedAt: Date.now()
  };

  const btn = document.getElementById("mSaveProductBtn");
  btn.disabled = true;

  try {
    if (editId) {
      await updateDoc(doc(db, "nafal_products", editId), prodData);
      showToast("تم تحديث المنتج بنجاح");
    } else {
      prodData.createdAt = Date.now();
      await addDoc(collection(db, "nafal_products"), prodData);
      showToast("تمت إضافة المنتج لمتجرك بنجاح");
    }
    resetMerchantProductForm();
  } catch (err) {
    console.error(err);
    showToast("حدث خطأ أثناء حفظ المنتج");
  } finally {
    btn.disabled = false;
  }
});

function resetMerchantProductForm() {
  document.getElementById("mProductForm").reset();
  document.getElementById("mEditProductId").value = "";
  mUploadedImagesList = [];
  renderMerchantUploadedThumbs();
  document.getElementById("mUploadStatus").textContent = "اضغط لاختيار صورة أو عدة صور (حتى 4 صور للمنتج)";
  document.getElementById("mFormAccordionTitle").textContent = "إضافة منتج أو بكج عرض جديد";
}

document.getElementById("mResetProductBtn").addEventListener("click", resetMerchantProductForm);

function renderMerchantProducts(prods) {
  const container = document.getElementById("mProductsList");
  container.innerHTML = "";

  if (prods.length === 0) {
    container.innerHTML = `
      <div class="empty-box glass-panel">
        <i class="ri-shopping-bag-3-line"></i>
        <span>لا توجد منتجات في متجرك حالياً. أضف أول منتج من الأعلى.</span>
      </div>
    `;
    return;
  }

  prods.forEach(p => {
    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      <img src="${p.imageUrl || DEFAULT_PRODUCT_IMG}" alt="${p.name}">
      <div class="product-card-body">
        <div class="product-card-title">${p.productType === "bundle" ? "🔥 " : ""}${p.name}</div>
        <div style="font-size:0.82rem; color:var(--text-secondary); font-weight:700;">
          ${p.category} | المخزون: ${p.stock} | الصور: ${(p.images || []).length || 1}
        </div>
        <div class="product-card-meta">
          <span>${p.price} ريال ${p.oldPrice ? `<del style="color:var(--text-secondary); font-size:0.8rem;">${p.oldPrice}</del>` : ""}</span>
          <span style="font-size:0.75rem;">${p.freeDelivery ? "توصيل مجاني" : ""}</span>
        </div>
        <div class="product-card-actions">
          <button type="button" class="btn-glass edit-btn" style="flex:1; justify-content:center; padding:8px;">
            <i class="ri-edit-line"></i><span>تعديل</span>
          </button>
          <button type="button" class="btn-danger-glass del-btn">
            <i class="ri-delete-bin-line"></i>
          </button>
        </div>
      </div>
    `;

    card.querySelector(".edit-btn").addEventListener("click", () => {
      document.getElementById("mProductFormAccordion").classList.add("open");
      document.getElementById("mFormAccordionTitle").textContent = `تعديل: ${p.name}`;
      document.getElementById("mEditProductId").value = p.id;
      document.getElementById("mProdName").value = p.name;
      document.getElementById("mProdType").value = p.productType || "regular";
      document.getElementById("mProdCategory").value = p.category;
      document.getElementById("mProdPrice").value = p.price;
      document.getElementById("mProdOldPrice").value = p.oldPrice || "";
      document.getElementById("mProdStock").value = p.stock;
      document.getElementById("mProdWeight").value = p.weight || "";
      document.getElementById("mProdNotes").value = p.notes || "";
      document.getElementById("mProdDesc").value = p.description || "";
      document.getElementById("mProdFreeDelivery").checked = !!p.freeDelivery;
      mUploadedImagesList = Array.isArray(p.images) && p.images.length ? [...p.images] : (p.imageUrl ? [p.imageUrl] : []);
      renderMerchantUploadedThumbs();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    card.querySelector(".del-btn").addEventListener("click", async () => {
      if (confirm(`حذف "${p.name}"؟`)) {
        await deleteDoc(doc(db, "nafal_products", p.id));
        showToast("تم حذف المنتج");
      }
    });

    container.appendChild(card);
  });
}

// عرض وإدارة فواتير التاجر
document.querySelectorAll("#mOrderFilterBar .filter-pill").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#mOrderFilterBar .filter-pill").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    mSelectedOrderFilter = btn.dataset.status;
    updateMerchantStatsAndOrders();
  });
});

function updateMerchantStatsAndOrders() {
  const newCount = mAllOrders.filter(o => o.status === "جديد - قيد المراجعة").length;
  const completedOrders = mAllOrders.filter(o => o.status === "تم التوصيل");
  const totalRev = completedOrders.reduce((sum, o) => sum + (Number(o.totalAmount) || 0), 0);

  document.getElementById("mStatRevenue").textContent = totalRev;
  document.getElementById("mStatNewOrders").textContent = newCount;
  document.getElementById("mStatCompletedOrders").textContent = completedOrders.length;
  document.getElementById("mOrdersBadge").textContent = newCount;

  const container = document.getElementById("mOrdersAccordionList");
  container.innerHTML = "";

  const filtered = mSelectedOrderFilter === "all"
    ? mAllOrders
    : mAllOrders.filter(o => o.status === mSelectedOrderFilter);

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
    container.appendChild(createOrderAccordionCard(order, index === 0 && order.status === "جديد - قيد المراجعة", true));
  });
}

// دالة موحدة لبناء بطاقة الفاتورة المنسدلة (تعمل للتاجر وللمندوب)
function createOrderAccordionCard(order, openByDefault = false, isMerchant = true) {
  const statusMeta = getStatusMeta(order.status);
  const accordion = document.createElement("div");
  accordion.className = `invoice-accordion glass-panel ${openByDefault ? "open" : ""}`;

  const itemsHtml = (order.items || []).map(i => `• <strong>${i.name}</strong> (الكمية: ${i.qty} × ${i.price} ريال)`).join("<br>");
  const customerPhone = (order.customerPhone || "").replace(/[^0-9]/g, "");
  const courierLine = order.courierName ? `\nالمندوب: ${order.courierName} (${order.courierPhone || ""})` : "";
  const waUpdateMsg = encodeURIComponent(
    `مرحباً ${order.customerName}\nتحديث بخصوص فاتورتك رقم (#${order.invoiceNumber}) من ${order.storeName || "متجرنا"}:\nالحالة الآن: *${order.status}*${courierLine}\nالإجمالي: ${order.totalAmount} ريال.`
  );

  const statusButtonsHtml = ORDER_STATUS_LIST.map(st => `
    <button type="button" class="status-option-btn ${order.status === st.value ? 'selected' : ''}" data-val="${st.value}">
      <div class="opt-main">
        <i class="${st.icon}"></i>
        <span>${st.value}</span>
      </div>
      <i class="${order.status === st.value ? 'ri-check-double-line' : 'ri-arrow-left-s-line'}"></i>
    </button>
  `).join("");

  accordion.innerHTML = `
    <button type="button" class="invoice-summary-bar">
      <div class="invoice-summary-right">
        <div class="expand-circle"><i class="ri-arrow-down-s-line"></i></div>
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

    <div class="invoice-details-body">
      <div class="status-control-section">
        <div class="status-control-label">
          <i class="ri-exchange-box-line" style="color:var(--caramel); font-size:1.3rem;"></i>
          <span>اضغط لتغيير حالة الفاتورة (تتحدث عند الزبون فوراً):</span>
        </div>

        <div class="status-dropdown-wrapper">
          <button type="button" class="status-dropdown-trigger">
            <span>الحالة الحالية: ${order.status}</span>
            <i class="ri-arrow-down-s-fill"></i>
          </button>
          <div class="status-dropdown-menu">
            ${statusButtonsHtml}
          </div>
        </div>
      </div>

      <div class="inv-info-grid">
        <div class="inv-box glass-inset">
          <h4><i class="ri-user-location-line"></i> بيانات الزبون والعنوان</h4>
          <div><strong>الاسم:</strong> ${order.customerName}</div>
          <div><strong>الجوال:</strong> <a href="tel:${order.customerPhone}" style="color:var(--espresso); font-weight:900;">${order.customerPhone}</a></div>
          <div><strong>العنوان:</strong> ${order.customerAddress || "داخل شرورة"}</div>
          ${order.courierName ? `<div><strong>المندوب المستلم:</strong> ${order.courierName} (${order.courierPhone})</div>` : ""}
        </div>

        <div class="inv-box glass-inset">
          <h4><i class="ri-shopping-bag-3-line"></i> الطلبات</h4>
          <div>${itemsHtml}</div>
          <div style="margin-top:8px; padding-top:8px; border-top:1px dashed rgba(30,19,13,0.15); font-weight:900;">
            التوصيل: ${order.deliveryFee} ريال | الإجمالي: ${order.totalAmount} ريال
          </div>
        </div>
      </div>

      <div class="inv-actions-row">
        <a href="https://wa.me/${customerPhone}?text=${waUpdateMsg}" target="_blank" class="whatsapp-btn-lg">
          <i class="ri-whatsapp-line"></i>
          <span>إشعار الزبون عبر واتساب</span>
        </a>
        ${order.gpsLocation ? `
          <a href="${order.gpsLocation}" target="_blank" class="gps-btn-lg">
            <i class="ri-map-pin-2-fill"></i>
            <span>فتح موقع الزبون (GPS)</span>
          </a>
        ` : ""}
        ${isMerchant ? `
          <button type="button" class="btn-danger-glass del-order-btn">
            <i class="ri-delete-bin-line"></i>
            <span>حذف</span>
          </button>
        ` : ""}
      </div>
    </div>
  `;

  accordion.querySelector(".invoice-summary-bar").addEventListener("click", () => {
    accordion.classList.toggle("open");
  });

  const dropdownWrap = accordion.querySelector(".status-dropdown-wrapper");
  accordion.querySelector(".status-dropdown-trigger").addEventListener("click", () => {
    dropdownWrap.classList.toggle("open");
  });

  accordion.querySelectorAll(".status-option-btn").forEach(optBtn => {
    optBtn.addEventListener("click", async () => {
      const newStatus = optBtn.dataset.val;
      dropdownWrap.classList.remove("open");

      const updatePayload = {
        status: newStatus,
        updatedAt: Date.now()
      };

      // إذا كان المستخدم الحالي مندوب واختار "مع المندوب للتوصيل"، نحفظ اسمه ورقمه للزبون تلقائياً
      if (currentSession && currentSession.role === "staff" && newStatus === "مع المندوب للتوصيل") {
        updatePayload.courierName = currentSession.name;
        updatePayload.courierPhone = currentSession.phone;
      }

      await updateDoc(doc(db, "nafal_orders", order.id), updatePayload);
      showToast(`تم تحديث الفاتورة #${order.invoiceNumber} إلى: ${newStatus}`);
    });
  });

  const delBtn = accordion.querySelector(".del-order-btn");
  if (delBtn) {
    delBtn.addEventListener("click", async () => {
      if (confirm(`حذف الفاتورة #${order.invoiceNumber}؟`)) {
        await deleteDoc(doc(db, "nafal_orders", order.id));
        showToast("تم حذف الفاتورة");
      }
    });
  }

  return accordion;
}

// حفظ إعدادات الدوام، رمز الفاتورة، الحد الأدنى، وعروض التوصيل للتاجر
document.getElementById("mWorkOffersForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!mCurrentStore) return;

  await updateDoc(doc(db, "nafal_stores", mCurrentStore.id), {
    workMode: document.getElementById("mWorkMode").value,
    openTime: document.getElementById("mOpenTime").value,
    closeTime: document.getElementById("mCloseTime").value,
    invoicePrefix: document.getElementById("mInvoicePrefix").value.trim().toUpperCase() || "NF",
    minOrderAmount: Number(document.getElementById("mMinOrderAmount").value) || 0,
    baseDeliveryFee: Number(document.getElementById("mBaseDeliveryFee").value) || 0,
    enableSmartOffers: document.getElementById("mEnableSmartOffers").checked,
    promoMessage: document.getElementById("mPromoMessage").value.trim(),
    tier1Threshold: Number(document.getElementById("mTier1Threshold").value) || 100,
    tier1Fee: Number(document.getElementById("mTier1Fee").value) || 0,
    tier2Threshold: Number(document.getElementById("mTier2Threshold").value) || 300,
    tier2Fee: Number(document.getElementById("mTier2Fee").value) || 0,
    updatedAt: Date.now()
  });

  showToast("تم حفظ أوقات الدوام وعروض التوصيل لمتجرك");
});

// إدارة الموظفين والمناديب للتاجر
document.getElementById("mStaffForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!mCurrentStore) return;

  const editStaffId = document.getElementById("mEditStaffId").value.trim();
  const payload = {
    storeId: mCurrentStore.id,
    storeName: mCurrentStore.name,
    name: document.getElementById("mStaffName").value.trim(),
    phone: document.getElementById("mStaffPhone").value.trim(),
    role: document.getElementById("mStaffRole").value,
    username: document.getElementById("mStaffUsername").value.trim(),
    password: document.getElementById("mStaffPassword").value.trim(),
    updatedAt: Date.now()
  };

  if (editStaffId) {
    await updateDoc(doc(db, "nafal_staff", editStaffId), payload);
    showToast("تم تحديث بيانات الموظف");
  } else {
    payload.createdAt = Date.now();
    await addDoc(collection(db, "nafal_staff"), payload);
    showToast("تمت إضافة الموظف بنجاح");
  }
  document.getElementById("mStaffForm").reset();
  document.getElementById("mEditStaffId").value = "";
});

document.getElementById("mResetStaffBtn").addEventListener("click", () => {
  document.getElementById("mStaffForm").reset();
  document.getElementById("mEditStaffId").value = "";
});

function renderMerchantStaff(staffList) {
  const container = document.getElementById("mStaffList");
  container.innerHTML = "";

  if (staffList.length === 0) {
    container.innerHTML = `
      <div class="empty-box glass-panel">
        <i class="ri-team-line"></i>
        <span>لم تضف أي موظف أو مندوب بعد</span>
      </div>
    `;
    return;
  }

  staffList.forEach(sf => {
    const card = document.createElement("div");
    card.className = "glass-panel form-card";
    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
        <div>
          <strong style="font-size:1.08rem;">${sf.name} (${sf.role})</strong>
          <div class="sub-hint">جوال: <span dir="ltr">${sf.phone}</span> | اسم الدخول: <strong dir="ltr">${sf.username}</strong> | كلمة المرور: <strong dir="ltr">${sf.password}</strong></div>
        </div>
        <div style="display:flex; gap:8px;">
          <button type="button" class="btn-glass edit-sf-btn"><i class="ri-edit-line"></i> تعديل</button>
          <button type="button" class="btn-danger-glass del-sf-btn"><i class="ri-delete-bin-line"></i></button>
        </div>
      </div>
    `;

    card.querySelector(".edit-sf-btn").addEventListener("click", () => {
      document.getElementById("mEditStaffId").value = sf.id;
      document.getElementById("mStaffName").value = sf.name;
      document.getElementById("mStaffPhone").value = sf.phone;
      document.getElementById("mStaffRole").value = sf.role;
      document.getElementById("mStaffUsername").value = sf.username;
      document.getElementById("mStaffPassword").value = sf.password;
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    card.querySelector(".del-sf-btn").addEventListener("click", async () => {
      if (confirm(`حذف حساب الموظف "${sf.name}"؟`)) {
        await deleteDoc(doc(db, "nafal_staff", sf.id));
        showToast("تم حذف الموظف");
      }
    });

    container.appendChild(card);
  });
}

// إرسال طلب تغيير اسم المتجر للإدارة العليا
document.getElementById("mSendNameRequestBtn").addEventListener("click", async () => {
  if (!mCurrentStore) return;
  const newName = document.getElementById("mRequestedStoreName").value.trim();
  if (!newName) return showToast("اكتب الاسم الجديد المقترح أولاً");

  await addDoc(collection(db, "nafal_name_requests"), {
    storeId: mCurrentStore.id,
    oldName: mCurrentStore.name,
    requestedName: newName,
    status: "pending",
    createdAt: Date.now()
  });

  document.getElementById("mRequestedStoreName").value = "";
  document.getElementById("mPendingNameHint").textContent = `تم إرسال طلب تغيير الاسم إلى "${newName}" للإدارة العليا للمراجعة.`;
  showToast("تم إرسال طلب تغيير الاسم للإدارة العليا");
});

// رفع شعار التاجر وتحديد موقع المحل بالـ GPS
document.getElementById("mLogoFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("mLogoUploadStatus");
  statusEl.textContent = "جاري ضغط ورفع شعار متجرك...";
  try {
    const url = await uploadImageToImgBB(file);
    document.getElementById("mStoreLogoUrl").value = url;
    const prev = document.getElementById("mLogoPreview");
    prev.src = url;
    prev.classList.remove("hidden");
    statusEl.textContent = "تم رفع شعار المتجر بنجاح! اضغط حفظ بالأسفل";
  } catch {
    statusEl.textContent = "تعذر رفع الشعار";
  }
});

document.getElementById("mCaptureGpsBtn").addEventListener("click", () => {
  if (!navigator.geolocation) return showToast("متصفحك لا يدعم الـ GPS");
  showToast("جاري تحديد موقع المحل...");
  navigator.geolocation.getCurrentPosition(pos => {
    const url = `https://maps.google.com/?q=${pos.coords.latitude},${pos.coords.longitude}`;
    document.getElementById("mMapsUrlInput").value = url;
    showToast("تم التقاط موقع المحل بنجاح");
  }, () => {
    showToast("تعذر التقاط الموقع، الصق رابط خرائط قوقل يدوياً");
  });
});

document.getElementById("mIdentityForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!mCurrentStore) return;

  await updateDoc(doc(db, "nafal_stores", mCurrentStore.id), {
    description: document.getElementById("mStoreDescInput").value.trim(),
    logo: document.getElementById("mStoreLogoUrl").value.trim(),
    whatsappNumber: document.getElementById("mWhatsappInput").value.trim(),
    mapsUrl: document.getElementById("mMapsUrlInput").value.trim(),
    snapchatUrl: document.getElementById("mSnapInput").value.trim(),
    tiktokUrl: document.getElementById("mTiktokInput").value.trim(),
    instagramUrl: document.getElementById("mInstaInput").value.trim(),
    updatedAt: Date.now()
  });

  showToast("تم حفظ هوية متجرك وموقع المحل بنجاح");
});

// أقسام متجر التاجر الداخلية
function renderMerchantCategories() {
  const select = document.getElementById("mProdCategory");
  const list = document.getElementById("mCategoriesList");
  select.innerHTML = "";
  list.innerHTML = "";

  mStoreCategories.forEach((cat, idx) => {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    select.appendChild(opt);

    const li = document.createElement("li");
    li.className = "cat-item glass-inset";
    li.innerHTML = `
      <span><i class="ri-price-tag-3-line" style="color:var(--caramel); margin-left:8px;"></i>${cat}</span>
      <button type="button" class="btn-danger-glass"><i class="ri-delete-bin-line"></i></button>
    `;
    li.querySelector("button").addEventListener("click", async () => {
      if (mStoreCategories.length <= 1) return showToast("يجب بقاء قسم واحد على الأقل");
      mStoreCategories.splice(idx, 1);
      await updateDoc(doc(db, "nafal_stores", mCurrentStore.id), { categories: mStoreCategories });
      showToast("تم حذف القسم");
    });
    list.appendChild(li);
  });
}

document.getElementById("mAddCatBtn").addEventListener("click", async () => {
  if (!mCurrentStore) return;
  const input = document.getElementById("mNewCatInput");
  const val = input.value.trim();
  if (!val) return;
  if (!mStoreCategories.includes(val)) {
    mStoreCategories.push(val);
    await updateDoc(doc(db, "nafal_stores", mCurrentStore.id), { categories: mStoreCategories });
    input.value = "";
    showToast("تمت إضافة القسم لمتجرك");
  }
});

// تغيير بيانات دخول التاجر
document.getElementById("mCredentialsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!mCurrentStore) return;
  const newUser = document.getElementById("mSelfNewUser").value.trim();
  const newPass = document.getElementById("mSelfNewPass").value.trim();

  await updateDoc(doc(db, "nafal_stores", mCurrentStore.id), {
    merchantUsername: newUser,
    merchantPassword: newPass
  });

  currentSession.username = newUser;
  localStorage.setItem("nafal_portal_session", JSON.stringify(currentSession));
  document.getElementById("currentUserDisplay").textContent = newUser;
  showToast("تم تحديث بيانات دخولك كتاجر");
});

// ============================================================================
// القسم الثالث: منطق الموظف / مندوب التوصيل (Staff / Courier View)
// ============================================================================
let staffOrdersList = [];
let staffFilterMode = "active";

function initStaffPortal(session) {
  document.getElementById("portalTitle").textContent = `مهام: ${session.name}`;
  document.getElementById("portalSubtitle").textContent = `${session.staffRole} — صلاحية متابعة وتوصيل الطلبات فقط`;
  document.getElementById("staffWelcomeTitle").textContent = `أهلاً بك يا ${session.name} (${session.staffRole})`;

  const qOrders = query(collection(db, "nafal_orders"), where("storeId", "==", session.storeId));
  const unsub = onSnapshot(qOrders, snap => {
    staffOrdersList = [];
    snap.forEach(d => staffOrdersList.push({ id: d.id, ...d.data() }));
    staffOrdersList.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    renderStaffOrders();
  });

  activeUnsubscribers.push(unsub);
}

document.querySelectorAll("#staffFilterBar .filter-pill").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#staffFilterBar .filter-pill").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    staffFilterMode = btn.dataset.status;
    renderStaffOrders();
  });
});

function renderStaffOrders() {
  const container = document.getElementById("staffOrdersAccordionList");
  container.innerHTML = "";

  const filtered = staffFilterMode === "active"
    ? staffOrdersList.filter(o => o.status !== "تم التوصيل" && o.status !== "ملغي")
    : staffOrdersList.filter(o => o.status === "تم التوصيل");

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-box glass-panel">
        <i class="ri-e-bike-2-line"></i>
        <span>لا توجد طلبات في هذه القائمة حالياً</span>
      </div>
    `;
    return;
  }

  filtered.forEach((order, idx) => {
    container.appendChild(createOrderAccordionCard(order, idx === 0, false));
  });
}

// استعادة الجلسة تلقائياً عند تحديث الصفحة
const savedSessionRaw = localStorage.getItem("nafal_portal_session");
if (savedSessionRaw) {
  try {
    const parsed = JSON.parse(savedSessionRaw);
    if (parsed && parsed.role) {
      startSession(parsed);
    }
  } catch {
    localStorage.removeItem("nafal_portal_session");
  }
} else {
  ensurePlatformInitialized();
}
