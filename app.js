// ============================================================================
// ملف المحرك الأمني الشامل لبوابة نفال (app.js) — الجزء الأول (1 / 2)
// ============================================================================
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { 
  initializeFirestore, getFirestore, collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, onSnapshot, query, where 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// 1. إعدادات الاتصال بقاعدة بيانات فايربيس
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAtCSiIDDN9nceKMj2xZbjREy9qXFEv68k",
  authDomain: "rawi-ye02.firebaseapp.com",
  projectId: "rawi-ye02",
  storageBucket: "rawi-ye02.firebasestorage.app",
  messagingSenderId: "247996335759",
  appId: "1:247996335759:web:846f6e93f75175bddc92fa",
  measurementId: "G-0RDKKNKSJJ"
};

const DEFAULT_IMGBB_KEY = "0fbdc2c45d1d7098137c923129bd25b7";
const DEFAULT_UPLOAD_ENDPOINT = "https://api.imgbb.com/1/upload";
const DEFAULT_PRODUCT_IMG = "https://images.unsplash.com/photo-1559056199-641a0ac8b55e?auto=format&fit=crop&w=800&q=80";

let app;
let db;
if (getApps().length === 0) {
  app = initializeApp(FIREBASE_CONFIG);
  db = initializeFirestore(app, {
    ignoreUndefinedProperties: true
  });
} else {
  app = getApps()[0];
  db = getFirestore(app);
}

// متغيرات مفتاح الـ API الديناميكية (تُدار حصرياً من خزنة الإدارة العليا)
let dynamicImgbbApiKey = DEFAULT_IMGBB_KEY;
let dynamicUploadEndpoint = DEFAULT_UPLOAD_ENDPOINT;

// متغيرات الجلسة والأمان والصلاحيات
let currentSession = null; 
let isSuperAdminManagingStore = false;
let savedSuperAdminSession = null;
let activeUnsubscribers = [];
let enteredPinBuffer = "";
let isPinLocked = false;
let idleLockTimer = null;
const IDLE_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

// حماية النصوص من ثغرات XSS
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// توحيد الأرقام العربية/الفارسية إلى إنجليزية وتنظيف النص للبحث الذكي
function normalizeSearchText(str) {
  if (!str) return "";
  return String(str)
    .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .trim();
}

// ============================================================================
// حارس تفرد اسم المستخدم الشامل (Global Username Uniqueness Guard)
// يمنع تكرار اسم المستخدم في كل النظام دون كشف صاحب الاسم، ويتيح الاسم إذا حُذف صاحبه
// ============================================================================
async function isUsernameTakenGlobally(candidateUsername, excludeRole = null, excludeDocId = null) {
  const cleanCandidate = (candidateUsername || "").trim().toLowerCase();
  if (!cleanCandidate) return true;

  // 1. فحص وثيقة الإدارة العليا
  if (!(excludeRole === "superadmin" && excludeDocId === "superAdmin")) {
    const adminSnap = await getDoc(doc(db, "nafal_platform", "superAdmin"));
    if (adminSnap.exists()) {
      const adminUser = (adminSnap.data().username || "").trim().toLowerCase();
      if (adminUser && adminUser === cleanCandidate) {
        return true;
      }
    }
  }

  // 2. فحص جميع المتاجر النشطة في القاعدة
  const storesSnap = await getDocs(collection(db, "nafal_stores"));
  for (const docSnap of storesSnap.docs) {
    if (excludeRole === "merchant" && docSnap.id === excludeDocId) continue;
    const storeUser = (docSnap.data().merchantUsername || "").trim().toLowerCase();
    if (storeUser && storeUser === cleanCandidate) {
      return true;
    }
  }

  // 3. فحص جميع الموظفين والمناديب النشطين في القاعدة
  const staffSnap = await getDocs(collection(db, "nafal_staff"));
  for (const docSnap of staffSnap.docs) {
    if (excludeRole === "staff" && docSnap.id === excludeDocId) continue;
    const staffUser = (docSnap.data().username || "").trim().toLowerCase();
    if (staffUser && staffUser === cleanCandidate) {
      return true;
    }
  }

  return false;
}

// دالة الفحص الذكي للفاتورة
function matchesSmartOrderQuery(order, rawQuery) {
  if (!rawQuery || !rawQuery.trim()) return true;

  const qNorm = normalizeSearchText(rawQuery);
  const qCompact = qNorm.replace(/[\s\-#+]/g, "");

  const invNorm = normalizeSearchText(order.invoiceNumber || "");
  const invCompact = invNorm.replace(/[\s\-#]/g, "");

  const phoneNorm = normalizeSearchText(order.customerPhone || "");
  const phoneCompact = phoneNorm.replace(/[^0-9]/g, "");

  const nameNorm = normalizeSearchText(order.customerName || "");
  const addrNorm = normalizeSearchText(order.customerAddress || "");
  const courierNorm = normalizeSearchText(order.courierName || "");
  const itemsNorm = (order.items || []).map(i => normalizeSearchText(i.name || "")).join(" ");

  if (qCompact && (invCompact.includes(qCompact) || phoneCompact.includes(qCompact))) {
    return true;
  }

  return (
    invNorm.includes(qNorm) ||
    phoneNorm.includes(qNorm) ||
    nameNorm.includes(qNorm) ||
    addrNorm.includes(qNorm) ||
    courierNorm.includes(qNorm) ||
    itemsNorm.includes(qNorm)
  );
}

// توليد أو جلب البصمة الفريدة للجهاز الحالي (Device ID)
function getOrCreateDeviceId() {
  let devId = localStorage.getItem("nafal_trusted_device_id");
  if (!devId) {
    devId = "DEV-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).substring(2, 8).toUpperCase();
    localStorage.setItem("nafal_trusted_device_id", devId);
  }
  return devId;
}

function getDeviceFriendlyName() {
  const ua = navigator.userAgent || "";
  let os = "جهاز ذكي";
  if (/android/i.test(ua)) os = "جوال أندرويد";
  else if (/iPad|iPhone|iPod/.test(ua)) os = "جهاز آيفون / آيباد";
  else if (/CrOS/.test(ua)) os = "لابتوب ChromeOS";
  else if (/Win/.test(ua)) os = "كمبيوتر ويندوز";
  else if (/Mac/.test(ua)) os = "جهاز ماك";

  let browser = "متصفح ويب";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = "Safari";
  else if (/Firefox\//.test(ua)) browser = "Firefox";

  return `${os} (${browser})`;
}

// حالات الطلب المعتمدة
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

let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById("toast");
  const toastText = document.getElementById("toastText");
  if (!toast || !toastText) return;
  toastText.textContent = msg;
  toast.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 3200);
}

function clearSubscriptions() {
  activeUnsubscribers.forEach(unsub => {
    if (typeof unsub === "function") unsub();
  });
  activeUnsubscribers = [];
}

// تفعيل أزرار أيقونة العين (👁️) لإظهار/إخفاء كلمات المرور والرموز السريعة
function initPasswordRevealButtons() {
  document.querySelectorAll(".toggle-eye-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.target;
      const input = document.getElementById(targetId);
      if (!input) return;
      const icon = btn.querySelector("i");
      if (input.type === "password") {
        input.type = "text";
        if (icon) icon.className = "ri-eye-off-line";
      } else {
        input.type = "password";
        if (icon) icon.className = "ri-eye-line";
      }
    });
  });
}

// ============================================================================
// 2. نافذة التأكيد الزجاجية الذكية لكل الأزرار التنفيذية (Smart Confirmation Modal)
// ============================================================================
let pendingConfirmAction = null;

function confirmAction({ title = "تأكيد الإجراء", message = "هل أنت متأكد من تنفيذ هذا الإجراء؟", confirmText = "نعم، متأكد", isDanger = false, onConfirm }) {
  const modal = document.getElementById("confirmModal");
  if (!modal) {
    if (window.confirm(message)) onConfirm();
    return;
  }

  document.getElementById("confirmModalTitle").textContent = title;
  document.getElementById("confirmModalMessage").textContent = message;

  const yesBtn = document.getElementById("confirmModalYesBtn");
  const yesText = document.getElementById("confirmModalYesText");
  if (yesText) yesText.textContent = confirmText;

  if (isDanger) {
    yesBtn.className = "btn-danger-glass";
  } else {
    yesBtn.className = "btn-primary-glass";
  }

  pendingConfirmAction = onConfirm;
  modal.classList.remove("hidden");
}

function closeConfirmModal() {
  const modal = document.getElementById("confirmModal");
  if (modal) modal.classList.add("hidden");
  pendingConfirmAction = null;
}

document.getElementById("closeConfirmModalBtn")?.addEventListener("click", closeConfirmModal);
document.getElementById("confirmModalNoBtn")?.addEventListener("click", closeConfirmModal);
document.getElementById("confirmModalYesBtn")?.addEventListener("click", async () => {
  const fn = pendingConfirmAction;
  closeConfirmModal();
  if (typeof fn === "function") {
    await fn();
  }
});

// ============================================================================
// 3. ضغط ورفع الصور باستخدام مفتاح الـ API الديناميكي المحفوظ في القاعدة
// ============================================================================
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

async function fetchLatestApiKeyFromVault() {
  try {
    const snap = await getDoc(doc(db, "nafal_platform", "marketConfig"));
    if (snap.exists()) {
      const data = snap.data();
      if (data.imgbbApiKey && data.imgbbApiKey.trim() !== "") {
        dynamicImgbbApiKey = data.imgbbApiKey.trim();
      }
      if (data.uploadEndpoint && data.uploadEndpoint.trim() !== "") {
        dynamicUploadEndpoint = data.uploadEndpoint.trim();
      }
    }
  } catch (e) {
    console.warn("Using fallback API configuration:", e);
  }
}

async function uploadImageToImgBB(file) {
  await fetchLatestApiKeyFromVault();
  const base64 = await compressImage(file);
  const formData = new FormData();
  formData.append("image", base64);

  const separator = dynamicUploadEndpoint.includes("?") ? "&" : "?";
  const targetUrl = `${dynamicUploadEndpoint}${separator}key=${encodeURIComponent(dynamicImgbbApiKey)}`;

  const res = await fetch(targetUrl, {
    method: "POST",
    body: formData
  });
  const data = await res.json();
  if (data && data.success && data.data && data.data.display_url) {
    return data.data.display_url;
  }
  throw new Error("Upload Failed");
}

// ============================================================================
// 4. تهيئة البيانات الأساسية للمنصة أول مرة
// ============================================================================
async function ensurePlatformInitialized() {
  try {
    const adminRef = doc(db, "nafal_platform", "superAdmin");
    const adminSnap = await getDoc(adminRef);
    if (!adminSnap.exists()) {
      await setDoc(adminRef, {
        username: "abuturki",
        password: "Nafal@2026",
        pinCode: "",
        trustedDevices: [],
        updatedAt: Date.now()
      });
    }

    const configRef = doc(db, "nafal_platform", "marketConfig");
    const configSnap = await getDoc(configRef);
    if (!configSnap.exists()) {
      await setDoc(configRef, {
        showMarketplace: true,
        platformName: "سوق نفال — شرورة",
        platformSlogan: "ارحبوا.. متاجر شرورة بين يديك",
        platformBanner: "التوصيل والخدمة مخصصة لأهلنا داخل شرورة فقط",
        platformLogo: "",
        imgbbApiKey: DEFAULT_IMGBB_KEY,
        uploadEndpoint: DEFAULT_UPLOAD_ENDPOINT,
        marketCategories: ["متاجر القهوة والمحامص", "الأسر المنتجة والحلى", "العسل والسمن والتمور", "العطور والبخور", "متاجر متنوعة"]
      });
    } else {
      const cData = configSnap.data();
      if (cData.imgbbApiKey) dynamicImgbbApiKey = cData.imgbbApiKey;
      if (cData.uploadEndpoint) dynamicUploadEndpoint = cData.uploadEndpoint;
    }

    document.getElementById("diagnosticAlert").classList.add("hidden");
  } catch (err) {
    console.error("Init Error:", err);
    if ((err.code || "").includes("permission-denied")) {
      document.getElementById("diagnosticAlert").classList.remove("hidden");
    }
  }
}

// ============================================================================
// 5. إدارة الشاشات الأربع والأجهزة الموثوقة
// ============================================================================
function showOnlyScreen(screenId) {
  const screens = ["sessionCheckScreen", "pinLockScreen", "loginScreen", "portalApp"];
  screens.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("hidden", id !== screenId);
  });
}

function getAccountDocRef(role, docId) {
  if (role === "superadmin") return doc(db, "nafal_platform", "superAdmin");
  if (role === "merchant") return doc(db, "nafal_stores", docId);
  if (role === "staff") return doc(db, "nafal_staff", docId);
  return null;
}

async function registerTrustedDeviceInDb(role, docId, existingDevices = []) {
  const devId = getOrCreateDeviceId();
  const devName = getDeviceFriendlyName();
  const list = Array.isArray(existingDevices) ? [...existingDevices] : [];
  const idx = list.findIndex(d => d.deviceId === devId);

  const deviceEntry = {
    deviceId: devId,
    deviceName: devName,
    lastUsedAt: Date.now()
  };

  if (idx >= 0) {
    list[idx] = deviceEntry;
  } else {
    list.unshift(deviceEntry);
  }

  const ref = getAccountDocRef(role, docId);
  if (ref) {
    await updateDoc(ref, { trustedDevices: list });
  }
  return list;
}

function renderTrustedDevicesUI(containerId, devices = [], role, docId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";

  const myDevId = getOrCreateDeviceId();
  if (!Array.isArray(devices) || devices.length === 0) {
    container.innerHTML = `
      <div class="empty-box glass-inset">
        <i class="ri-smartphone-line"></i>
        <span>لا توجد أجهزة موثوقة مسجلة حالياً</span>
      </div>
    `;
    return;
  }

  devices.forEach(dev => {
    const isCurrent = dev.deviceId === myDevId;
    const card = document.createElement("div");
    card.className = "trusted-device-card";
    card.innerHTML = `
      <div class="td-info">
        <div class="td-icon"><i class="${(dev.deviceName || '').includes('جوال') || (dev.deviceName || '').includes('آيفون') ? 'ri-smartphone-line' : 'ri-macbook-line'}"></i></div>
        <div>
          <strong style="font-size:0.95rem;">
            ${escapeHtml(dev.deviceName || "جهاز موثوق")}
            ${isCurrent ? '<span class="td-current-badge">هذا الجهاز حالياً</span>' : ''}
          </strong>
          <div class="sub-hint">آخر نشاط: ${new Date(dev.lastUsedAt || Date.now()).toLocaleString("ar-SA")}</div>
        </div>
      </div>
      <button type="button" class="btn-danger-glass revoke-single-btn">
        <i class="ri-delete-bin-line"></i>
        <span>إزالة الجهاز</span>
      </button>
    `;

    card.querySelector(".revoke-single-btn").addEventListener("click", () => {
      confirmAction({
        title: "إزالة جهاز موثوق",
        message: `هل أنت متأكد من إلغاء الوثوق بالجهاز "${dev.deviceName}"؟ سيُطلب منه تسجيل الدخول بكلمة المرور.`,
        confirmText: "نعم، إزالة الجهاز",
        isDanger: true,
        onConfirm: async () => {
          const updated = devices.filter(d => d.deviceId !== dev.deviceId);
          const ref = getAccountDocRef(role, docId);
          if (ref) await updateDoc(ref, { trustedDevices: updated });
          showToast("تم إلغاء الوثوق بالجهاز بنجاح");
          if (isCurrent && !isSuperAdminManagingStore) {
            performFullLogout();
          }
        }
      });
    });

    container.appendChild(card);
  });
}

// ============================================================================
// 6. نافذة التحقق بالرمز السريع (مع إعفاء الإدارة العليا من قيود الرمز القديم)
// ============================================================================
let secModalCallback = null;

function openSecurityModal({ title, desc, confirmText = "تأكيد", onConfirm }) {
  const modal = document.getElementById("securityModal");
  document.getElementById("secModalTitle").textContent = title;
  document.getElementById("secModalDesc").textContent = desc;
  document.getElementById("secModalConfirmText").textContent = confirmText;
  const input = document.getElementById("secModalPinInput");
  input.value = "";
  secModalCallback = onConfirm;
  modal.classList.remove("hidden");
  setTimeout(() => input.focus(), 80);
}

function closeSecurityModal() {
  document.getElementById("securityModal").classList.add("hidden");
  document.getElementById("secModalPinInput").value = "";
  secModalCallback = null;
}

document.getElementById("closeSecModalBtn")?.addEventListener("click", closeSecurityModal);
document.getElementById("secModalCancelBtn")?.addEventListener("click", closeSecurityModal);

document.getElementById("secModalConfirmBtn")?.addEventListener("click", () => {
  const val = normalizeSearchText(document.getElementById("secModalPinInput").value);
  if (typeof secModalCallback === "function") {
    secModalCallback(val);
  }
});

document.getElementById("secModalPinInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("secModalConfirmBtn").click();
  }
});

function requirePinVerification(actionFn, customPrompt = "أدخل رمز الدخول السريع (4 أرقام) لتأكيد العملية:") {
  if (!currentSession || currentSession.role === "superadmin" || isSuperAdminManagingStore) {
    actionFn();
    return;
  }
  if (!currentSession.pinCode || currentSession.pinCode.length !== 4) {
    actionFn();
    return;
  }

  openSecurityModal({
    title: "تأكيد الأمان (4 أرقام)",
    desc: customPrompt,
    confirmText: "تأكيد وتنفيذ",
    onConfirm: async (enteredPin) => {
      if (enteredPin === currentSession.pinCode) {
        closeSecurityModal();
        await actionFn();
      } else {
        showToast("الرمز السريع غير صحيح! إذا نسيته تواصل مع إدارة المنصة");
      }
    }
  });
}

function offerQuickPinSetupIfMissing() {
  if (!currentSession || isSuperAdminManagingStore || (currentSession.pinCode && currentSession.pinCode.length === 4)) return;

  openSecurityModal({
    title: "تفعيل رمز الدخول السريع (اختياري)",
    desc: "هل ترغب في تعيين رمز أمان من 4 أرقام لحماية البوابة والدخول السريع بدون كلمة مرور؟ (أو اضغط تخطي):",
    confirmText: "حفظ الرمز",
    onConfirm: async (newPin) => {
      if (!/^\d{4}$/.test(newPin)) {
        showToast("يرجى إدخال 4 أرقام بالضبط أو الضغط على تخطي");
        return;
      }
      const ref = getAccountDocRef(currentSession.role, currentSession.docId);
      if (ref) {
        await updateDoc(ref, { pinCode: newPin });
        currentSession.pinCode = newPin;
        saveSessionLocally(currentSession);
        updateQuickLockButtonVisibility();
        showToast("تم تفعيل رمز الدخول السريع (4 أرقام) بنجاح!");
      }
      closeSecurityModal();
    }
  });
}

// ============================================================================
// 7. شاشة القفل بالرمز السريع (PIN Lock Screen) والقفل التلقائي عند الخمول
// ============================================================================
function updatePinDotsUI(isError = false) {
  const dots = document.querySelectorAll("#pinDotsContainer .pin-dot");
  dots.forEach((dot, idx) => {
    dot.classList.toggle("filled", idx < enteredPinBuffer.length);
    dot.classList.toggle("error", isError);
  });
}

function triggerPinLockScreen() {
  if (!currentSession || !currentSession.pinCode || currentSession.pinCode.length !== 4) return;
  isPinLocked = true;
  enteredPinBuffer = "";
  updatePinDotsUI(false);
  document.getElementById("pinWelcomeTitle").textContent = `مرحباً، ${currentSession.name}`;
  document.getElementById("pinSubPrompt").textContent = "الجلسة مؤمّنة — أدخل الرمز السريع (4 أرقام) للمتابعة";
  showOnlyScreen("pinLockScreen");
}

function handlePinDigitPress(digit) {
  if (!isPinLocked || enteredPinBuffer.length >= 4) return;
  enteredPinBuffer += String(digit);
  updatePinDotsUI(false);

  if (enteredPinBuffer.length === 4) {
    setTimeout(() => {
      if (currentSession && enteredPinBuffer === currentSession.pinCode) {
        isPinLocked = false;
        enteredPinBuffer = "";
        updatePinDotsUI(false);
        openPortalForSession(currentSession, false);
      } else {
        updatePinDotsUI(true);
        showToast("الرمز السريع غير صحيح");
        setTimeout(() => {
          enteredPinBuffer = "";
          updatePinDotsUI(false);
        }, 450);
      }
    }, 120);
  }
}

document.querySelectorAll(".pin-keypad .pin-key[data-digit]").forEach(btn => {
  btn.addEventListener("click", () => handlePinDigitPress(btn.dataset.digit));
});

document.getElementById("pinClearBtn")?.addEventListener("click", () => {
  enteredPinBuffer = "";
  updatePinDotsUI(false);
});

document.getElementById("pinBackBtn")?.addEventListener("click", () => {
  enteredPinBuffer = enteredPinBuffer.slice(0, -1);
  updatePinDotsUI(false);
});

window.addEventListener("keydown", (e) => {
  if (!isPinLocked) return;
  if (/^[0-9]$/.test(e.key)) {
    handlePinDigitPress(e.key);
  } else if (e.key === "Backspace") {
    enteredPinBuffer = enteredPinBuffer.slice(0, -1);
    updatePinDotsUI(false);
  } else if (e.key === "Escape") {
    enteredPinBuffer = "";
    updatePinDotsUI(false);
  }
});

document.getElementById("switchAccountFromPinBtn")?.addEventListener("click", () => {
  performFullLogout();
});

document.getElementById("quickLockBtn")?.addEventListener("click", () => {
  triggerPinLockScreen();
});

function updateQuickLockButtonVisibility() {
  const lockBtn = document.getElementById("quickLockBtn");
  if (!lockBtn) return;
  const hasPin = currentSession && currentSession.pinCode && currentSession.pinCode.length === 4;
  lockBtn.classList.toggle("hidden", !hasPin);
}

function resetIdleTimer() {
  if (idleLockTimer) clearTimeout(idleLockTimer);
  if (!currentSession || isPinLocked || !currentSession.pinCode || currentSession.pinCode.length !== 4) return;
  idleLockTimer = setTimeout(() => {
    triggerPinLockScreen();
  }, IDLE_LOCK_TIMEOUT_MS);
}

["mousemove", "keydown", "touchstart", "click"].forEach(evt => {
  window.addEventListener(evt, resetIdleTimer, { passive: true });
});

// ============================================================================
// 8. التحقق من الجلسة، تسجيل الدخول، وميزة الإدارة الشاملة لأي متجر
// ============================================================================
function saveSessionLocally(sessionObj) {
  localStorage.setItem("nafal_portal_session", JSON.stringify({
    role: sessionObj.role,
    docId: sessionObj.docId,
    storeId: sessionObj.storeId || "",
    username: sessionObj.username
  }));
}

async function verifySavedSessionOnStartup() {
  initPasswordRevealButtons();
  showOnlyScreen("sessionCheckScreen");
  await ensurePlatformInitialized();

  const raw = localStorage.getItem("nafal_portal_session");
  if (!raw) {
    showOnlyScreen("loginScreen");
    return;
  }

  try {
    const saved = JSON.parse(raw);
    const devId = getOrCreateDeviceId();
    const ref = getAccountDocRef(saved.role, saved.docId);
    if (!ref) throw new Error("Invalid Role");

    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error("Account Not Found");

    const data = snap.data();
    const trustedList = Array.isArray(data.trustedDevices) ? data.trustedDevices : [];
    const isDeviceTrusted = trustedList.some(d => d.deviceId === devId);

    if (!isDeviceTrusted) {
      localStorage.removeItem("nafal_portal_session");
      showOnlyScreen("loginScreen");
      return;
    }

    registerTrustedDeviceInDb(saved.role, saved.docId, trustedList).catch(() => {});

    let sessionPayload = null;
    if (saved.role === "superadmin") {
      sessionPayload = {
        role: "superadmin",
        docId: "superAdmin",
        username: data.username,
        name: "الإدارة العليا (أبو تركي)",
        pinCode: data.pinCode || ""
      };
    } else if (saved.role === "merchant") {
      sessionPayload = {
        role: "merchant",
        docId: snap.id,
        storeId: snap.id,
        username: data.merchantUsername,
        name: data.name,
        pinCode: data.pinCode || ""
      };
    } else if (saved.role === "staff") {
      sessionPayload = {
        role: "staff",
        docId: snap.id,
        storeId: data.storeId,
        username: data.username,
        name: data.name,
        phone: data.phone || "",
        staffRole: data.role || "مندوب توصيل",
        pinCode: data.pinCode || ""
      };
    }

    currentSession = sessionPayload;

    if (sessionPayload.pinCode && sessionPayload.pinCode.length === 4) {
      triggerPinLockScreen();
    } else {
      openPortalForSession(sessionPayload, false);
    }
  } catch (err) {
    console.warn("Session verification fallback to login:", err);
    localStorage.removeItem("nafal_portal_session");
    showOnlyScreen("loginScreen");
  }
}

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const userIn = document.getElementById("loginUsername").value.trim();
  const passIn = document.getElementById("loginPassword").value.trim();
  const trustDevice = document.getElementById("trustDeviceCheckbox").checked;
  const btn = document.getElementById("loginSubmitBtn");

  btn.disabled = true;
  btn.innerHTML = `<i class="ri-loader-4-line"></i><span>جاري التحقق وتأمين الجلسة...</span>`;

  try {
    await ensurePlatformInitialized();

    // 1. فحص حساب الإدارة العليا (أبو تركي)
    const adminSnap = await getDoc(doc(db, "nafal_platform", "superAdmin"));
    if (adminSnap.exists()) {
      const adminData = adminSnap.data();
      if ((adminData.username || "").trim().toLowerCase() === userIn.toLowerCase() && adminData.password === passIn) {
        if (trustDevice) {
          await registerTrustedDeviceInDb("superadmin", "superAdmin", adminData.trustedDevices || []);
        }
        const sessionObj = {
          role: "superadmin",
          docId: "superAdmin",
          username: adminData.username,
          name: "الإدارة العليا (أبو تركي)",
          pinCode: adminData.pinCode || ""
        };
        if (trustDevice) saveSessionLocally(sessionObj);
        openPortalForSession(sessionObj, trustDevice);
        return;
      }
    }

    // 2. فحص حسابات التجار
    const storesSnap = await getDocs(collection(db, "nafal_stores"));
    let matchedStore = null;
    storesSnap.forEach(docSnap => {
      const st = docSnap.data();
      if ((st.merchantUsername || "").trim().toLowerCase() === userIn.toLowerCase() && st.merchantPassword === passIn) {
        matchedStore = { id: docSnap.id, ...st };
      }
    });

    if (matchedStore) {
      if (trustDevice) {
        await registerTrustedDeviceInDb("merchant", matchedStore.id, matchedStore.trustedDevices || []);
      }
      const sessionObj = {
        role: "merchant",
        docId: matchedStore.id,
        storeId: matchedStore.id,
        username: matchedStore.merchantUsername,
        name: matchedStore.name,
        pinCode: matchedStore.pinCode || ""
      };
      if (trustDevice) saveSessionLocally(sessionObj);
      openPortalForSession(sessionObj, trustDevice);
      return;
    }

    // 3. فحص حسابات الموظفين والمناديب
    const staffSnap = await getDocs(collection(db, "nafal_staff"));
    let matchedStaff = null;
    staffSnap.forEach(docSnap => {
      const sf = docSnap.data();
      if ((sf.username || "").trim().toLowerCase() === userIn.toLowerCase() && sf.password === passIn) {
        matchedStaff = { id: docSnap.id, ...sf };
      }
    });

    if (matchedStaff) {
      if (trustDevice) {
        await registerTrustedDeviceInDb("staff", matchedStaff.id, matchedStaff.trustedDevices || []);
      }
      const sessionObj = {
        role: "staff",
        docId: matchedStaff.id,
        storeId: matchedStaff.storeId,
        username: matchedStaff.username,
        name: matchedStaff.name,
        phone: matchedStaff.phone || "",
        staffRole: matchedStaff.role || "مندوب توصيل",
        pinCode: matchedStaff.pinCode || ""
      };
      if (trustDevice) saveSessionLocally(sessionObj);
      openPortalForSession(sessionObj, trustDevice);
      return;
    }

    showToast("اسم المستخدم أو كلمة المرور غير صحيحة");
  } catch (err) {
    console.error("Login Error:", err);
    showToast("حدث خطأ في الاتصال بقاعدة البيانات");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="ri-login-circle-line"></i><span>تسجيل الدخول للمتجر</span>`;
  }
});

// ميزة دخول الإدارة العليا إلى لوحة أي تاجر لإدارة كل تفاصيله
function enterStoreAsSuperAdmin(storeObj) {
  if (!currentSession || currentSession.role !== "superadmin") return;
  savedSuperAdminSession = { ...currentSession };
  isSuperAdminManagingStore = true;

  const banner = document.getElementById("saImpersonationBanner");
  if (banner) {
    document.getElementById("saImpersonatedStoreName").textContent = storeObj.name;
    banner.classList.remove("hidden");
  }

  openPortalForSession({
    role: "merchant",
    docId: storeObj.id,
    storeId: storeObj.id,
    username: storeObj.merchantUsername,
    name: storeObj.name,
    pinCode: ""
  }, false);

  showToast(`أنت الآن تدير متجر "${storeObj.name}" بصلاحية الإدارة العليا الشاملة`);
}

document.getElementById("saExitImpersonationBtn")?.addEventListener("click", () => {
  if (!savedSuperAdminSession) return;
  isSuperAdminManagingStore = false;
  document.getElementById("saImpersonationBanner")?.classList.add("hidden");
  openPortalForSession(savedSuperAdminSession, false);
  savedSuperAdminSession = null;
  showToast("عدت إلى لوحة الإدارة العليا الرئيسية");
});

function openPortalForSession(sessionData, promptForPinIfMissing = false) {
  currentSession = sessionData;
  isPinLocked = false;

  showOnlyScreen("portalApp");

  document.getElementById("superAdminView").classList.add("hidden");
  document.getElementById("merchantView").classList.add("hidden");
  document.getElementById("staffView").classList.add("hidden");

  clearSubscriptions();
  updateQuickLockButtonVisibility();
  resetIdleTimer();

  if (sessionData.role === "superadmin") {
    isSuperAdminManagingStore = false;
    document.getElementById("saImpersonationBanner")?.classList.add("hidden");
    document.getElementById("roleBadge").textContent = "المالك والإدارة العليا";
    document.getElementById("portalTitle").textContent = "البوابة الذكية — نفال";
    document.getElementById("portalSubtitle").textContent = "الإدارة العليا الشاملة للسوق والتجار — شرورة";
    document.getElementById("currentUserDisplay").textContent = sessionData.username;
    document.getElementById("superAdminView").classList.remove("hidden");
    initSuperAdminPortal();
  } else if (sessionData.role === "merchant") {
    document.getElementById("roleBadge").textContent = isSuperAdminManagingStore ? "إدارة عليا شاملة للمتجر" : "بوابة التاجر";
    document.getElementById("currentUserDisplay").textContent = sessionData.username;
    document.getElementById("merchantView").classList.remove("hidden");
    initMerchantPortal(sessionData.storeId);
  } else if (sessionData.role === "staff") {
    document.getElementById("roleBadge").textContent = sessionData.staffRole;
    document.getElementById("currentUserDisplay").textContent = sessionData.name;
    document.getElementById("staffView").classList.remove("hidden");
    initStaffPortal(sessionData);
  }

  if (promptForPinIfMissing && !isSuperAdminManagingStore && (!sessionData.pinCode || sessionData.pinCode.length !== 4)) {
    setTimeout(() => offerQuickPinSetupIfMissing(), 600);
  }
}

function performFullLogout() {
  clearSubscriptions();
  if (idleLockTimer) clearTimeout(idleLockTimer);
  currentSession = null;
  savedSuperAdminSession = null;
  isSuperAdminManagingStore = false;
  isPinLocked = false;
  document.getElementById("saImpersonationBanner")?.classList.add("hidden");
  localStorage.removeItem("nafal_portal_session");
  document.getElementById("loginForm").reset();
  showOnlyScreen("loginScreen");
  showToast("تم تسجيل الخروج وتأمين البوابة");
}

document.getElementById("logoutBtn").addEventListener("click", () => {
  confirmAction({
    title: "تأكيد تسجيل الخروج",
    message: "هل أنت متأكد من رغبتك في تسجيل الخروج من البوابة الآن؟",
    confirmText: "نعم، تسجيل الخروج",
    isDanger: true,
    onConfirm: performFullLogout
  });
});

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
setupTabNavigation("staffNavBar", "staffView");

// ============================================================================
// القسم الأول: منطق الإدارة العليا (المالك والأدمن الأعلى - صلاحيات شاملة)
// ============================================================================
let saMarketCategories = ["متاجر القهوة والمحامص", "الأسر المنتجة والحلى", "العسل والسمن والتمور", "العطور والبخور", "متاجر متنوعة"];
let saAllStores = [];
let saAllProducts = [];
let saAllOrders = [];
let saAllStaff = [];
let saStoreSearchQuery = "";

function initSuperAdminPortal() {
  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  document.getElementById("saSubExpiry").value = nextMonth.toISOString().split("T")[0];

  const unsubAdminDoc = onSnapshot(doc(db, "nafal_platform", "superAdmin"), snap => {
    if (!snap.exists()) return;
    const d = snap.data();
    document.getElementById("saAdminNewUser").value = d.username || "abuturki";
    document.getElementById("saAdminNewPass").value = d.password || "";
    document.getElementById("saAdminPinInput").value = d.pinCode || "";
    if (currentSession && currentSession.role === "superadmin") {
      currentSession.pinCode = d.pinCode || "";
      updateQuickLockButtonVisibility();
    }
    renderTrustedDevicesUI("saTrustedDevicesList", d.trustedDevices || [], "superadmin", "superAdmin");
  });

  const unsubConfig = onSnapshot(doc(db, "nafal_platform", "marketConfig"), snap => {
    if (snap.exists()) {
      const d = snap.data();
      document.getElementById("saShowMarketplaceToggle").checked = d.showMarketplace ?? true;
      document.getElementById("saPlatformName").value = d.platformName || "سوق نفال — شرورة";
      document.getElementById("saPlatformSlogan").value = d.platformSlogan || "";
      document.getElementById("saPlatformBanner").value = d.platformBanner || "";
      document.getElementById("saPlatformLogoUrl").value = d.platformLogo || "";
      document.getElementById("saImgbbApiKeyInput").value = d.imgbbApiKey || DEFAULT_IMGBB_KEY;
      document.getElementById("saUploadEndpointInput").value = d.uploadEndpoint || DEFAULT_UPLOAD_ENDPOINT;

      if (d.imgbbApiKey) dynamicImgbbApiKey = d.imgbbApiKey;
      if (d.uploadEndpoint) dynamicUploadEndpoint = d.uploadEndpoint;

      if (Array.isArray(d.marketCategories) && d.marketCategories.length > 0) {
        saMarketCategories = d.marketCategories;
      }
      renderSaMarketCategories();
    }
  });

  const unsubStores = onSnapshot(collection(db, "nafal_stores"), snap => {
    saAllStores = [];
    snap.forEach(d => saAllStores.push({ id: d.id, ...d.data() }));
    saAllStores.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    updateSaStatsAndStoresUI();
  });

  const unsubProds = onSnapshot(collection(db, "nafal_products"), snap => {
    saAllProducts = [];
    snap.forEach(d => saAllProducts.push({ id: d.id, ...d.data() }));
    updateSaStatsAndStoresUI();
  });

  const unsubOrders = onSnapshot(collection(db, "nafal_orders"), snap => {
    saAllOrders = [];
    snap.forEach(d => saAllOrders.push({ id: d.id, ...d.data() }));
    document.getElementById("saStatTotalOrders").textContent = saAllOrders.length;
    updateSaStatsAndStoresUI();
  });

  const unsubStaff = onSnapshot(collection(db, "nafal_staff"), snap => {
    saAllStaff = [];
    snap.forEach(d => saAllStaff.push({ id: d.id, ...d.data() }));
    updateSaStatsAndStoresUI();
  });

  const unsubNameReqs = onSnapshot(collection(db, "nafal_name_requests"), snap => {
    const reqs = [];
    snap.forEach(d => reqs.push({ id: d.id, ...d.data() }));
    reqs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const pendingReqs = reqs.filter(r => r.status === "pending");
    document.getElementById("saStatPendingNames").textContent = pendingReqs.length;
    document.getElementById("saRequestsBadge").textContent = pendingReqs.length;
    renderSaNameRequests(reqs);
  });

  activeUnsubscribers.push(unsubAdminDoc, unsubConfig, unsubStores, unsubProds, unsubOrders, unsubStaff, unsubNameReqs);
}

document.getElementById("saStoreSearchInput").addEventListener("input", (e) => {
  saStoreSearchQuery = e.target.value;
  document.getElementById("saClearStoreSearchBtn").classList.toggle("hidden", !saStoreSearchQuery.trim());
  updateSaStatsAndStoresUI();
});

document.getElementById("saClearStoreSearchBtn").addEventListener("click", () => {
  document.getElementById("saStoreSearchInput").value = "";
  saStoreSearchQuery = "";
  document.getElementById("saClearStoreSearchBtn").classList.add("hidden");
  updateSaStatsAndStoresUI();
});

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
      <span><i class="ri-store-2-line" style="color:var(--caramel); margin-left:8px;"></i>${escapeHtml(cat)}</span>
      <button type="button" class="btn-danger-glass"><i class="ri-delete-bin-line"></i></button>
    `;
    li.querySelector("button").addEventListener("click", () => {
      if (saMarketCategories.length <= 1) return showToast("يجب بقاء تصنيف واحد على الأقل");
      confirmAction({
        title: "حذف تصنيف من السوق",
        message: `هل أنت متأكد من حذف تصنيف "${cat}" من السوق الرئيسي؟`,
        confirmText: "نعم، حذف",
        isDanger: true,
        onConfirm: async () => {
          saMarketCategories.splice(idx, 1);
          await setDoc(doc(db, "nafal_platform", "marketConfig"), { marketCategories: saMarketCategories }, { merge: true });
          showToast("تم حذف التصنيف");
        }
      });
    });
    list.appendChild(li);
  });
}

document.getElementById("saAddMarketCatBtn").addEventListener("click", () => {
  const input = document.getElementById("saNewMarketCatInput");
  const val = input.value.trim();
  if (!val) return;
  if (!saMarketCategories.includes(val)) {
    confirmAction({
      title: "إضافة تصنيف للسوق",
      message: `هل تريد إضافة التصنيف "${val}" إلى قائمة تصنيفات سوق شرورة؟`,
      confirmText: "نعم، إضافة",
      onConfirm: async () => {
        saMarketCategories.push(val);
        await setDoc(doc(db, "nafal_platform", "marketConfig"), { marketCategories: saMarketCategories }, { merge: true });
        input.value = "";
        showToast("تمت إضافة تصنيف السوق");
      }
    });
  }
});

// حفظ أو تعديل المتجر من الإدارة العليا (مع فحص عدم تكرار اسم المستخدم في كل النظام)
document.getElementById("saStoreForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const editId = document.getElementById("saEditStoreId").value.trim();
  const prefix = document.getElementById("saStorePrefix").value.trim().toUpperCase() || "NF";
  const pinVal = normalizeSearchText(document.getElementById("saMerchantPin").value);
  const candidateUser = document.getElementById("saMerchantUsername").value.trim();

  if (pinVal !== "" && !/^\d{4}$/.test(pinVal)) {
    showToast("رمز الدخول السريع للتاجر يجب أن يكون 4 أرقام أو اتركه فارغاً لإلغائه");
    return;
  }

  // فحص عدم تكرار اسم المستخدم مع أي حساب آخر في القاعدة
  const isTaken = await isUsernameTakenGlobally(candidateUser, "merchant", editId || null);
  if (isTaken) {
    showToast("اسم المستخدم هذا محجوز ومستخدم حالياً، يرجى اختيار اسم آخر");
    return;
  }

  const storeNameVal = document.getElementById("saStoreName").value.trim();

  confirmAction({
    title: editId ? "تأكيد تحديث بيانات المتجر" : "تأكيد تأسيس متجر جديد",
    message: editId
      ? `هل أنت متأكد من حفظ التعديلات على متجر "${storeNameVal}"؟`
      : `هل أنت متأكد من تأسيس متجر "${storeNameVal}" ومنح الصلاحية للتاجر؟`,
    confirmText: "نعم، حفظ واعتماد",
    onConfirm: async () => {
      const storePayload = {
        name: storeNameVal,
        marketCategory: document.getElementById("saStoreCategory").value,
        invoicePrefix: prefix,
        whatsappNumber: document.getElementById("saStoreWhatsapp").value.trim(),
        merchantUsername: candidateUser,
        merchantPassword: document.getElementById("saMerchantPassword").value.trim(),
        pinCode: pinVal,
        baseDeliveryFee: Number(document.getElementById("saBaseDeliveryFee").value ?? 15),
        minOrderAmount: Number(document.getElementById("saMinOrderAmount").value ?? 0),
        workMode: document.getElementById("saWorkMode").value || "24h",
        subPlan: document.getElementById("saSubPlan").value,
        subPrice: Number(document.getElementById("saSubPrice").value) || 0,
        subExpiry: document.getElementById("saSubExpiry").value,
        storeStatus: document.getElementById("saStoreStatus").value,
        updatedAt: Date.now()
      };

      try {
        if (editId) {
          await updateDoc(doc(db, "nafal_stores", editId), storePayload);
          showToast("تم تحديث بيانات المتجر، الرمز السريع، والاشتراك بنجاح");
        } else {
          storePayload.createdAt = Date.now();
          storePayload.description = "متجر معتمد في سوق نفال — شرورة";
          storePayload.logo = "";
          storePayload.openTime = "08:00";
          storePayload.closeTime = "23:30";
          storePayload.enableSmartOffers = true;
          storePayload.promoMessage = "اطلب بـ 100 ريال والتوصيل بـ 5 ريال! وعند الطلب بـ 300 ريال التوصيل مجاني!";
          storePayload.tier1Threshold = 100;
          storePayload.tier1Fee = 5;
          storePayload.tier2Threshold = 300;
          storePayload.tier2Fee = 0;
          storePayload.categories = ["المنتجات المميزة", "بكجات وعروض", "أصناف متنوعة"];
          storePayload.ratingSum = 5;
          storePayload.ratingCount = 1;
          storePayload.trustedDevices = [];
          await addDoc(collection(db, "nafal_stores"), storePayload);
          showToast("تم تأسيس المتجر وإنشاء حساب التاجر بنجاح");
        }
        resetSaStoreForm();
      } catch (err) {
        console.error(err);
        showToast("حدث خطأ أثناء حفظ المتجر");
      }
    }
  });
});

function resetSaStoreForm() {
  document.getElementById("saStoreForm").reset();
  document.getElementById("saEditStoreId").value = "";
  document.getElementById("saMerchantPin").value = "";
  document.getElementById("saBaseDeliveryFee").value = "15";
  document.getElementById("saMinOrderAmount").value = "0";
  document.getElementById("saWorkMode").value = "24h";
  document.getElementById("saStoreFormTitle").textContent = "تأسيس متجر جديد ومنح صلاحية لتاجر";
  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  document.getElementById("saSubExpiry").value = nextMonth.toISOString().split("T")[0];
}

document.getElementById("saResetStoreFormBtn").addEventListener("click", resetSaStoreForm);

// عرض جميع المتاجر مع كشف كامل لبيانات التاجر والموظفين
function updateSaStatsAndStoresUI() {
  const todayStr = new Date().toISOString().split("T")[0];
  const activeCount = saAllStores.filter(s => s.storeStatus === "active" && (!s.subExpiry || s.subExpiry >= todayStr)).length;

  document.getElementById("saStatTotalStores").textContent = saAllStores.length;
  document.getElementById("saStatActiveStores").textContent = activeCount;

  const container = document.getElementById("saStoresAccordionList");
  container.innerHTML = "";

  const qNorm = normalizeSearchText(saStoreSearchQuery);
  const filteredStores = saAllStores.filter(st => {
    if (!qNorm) return true;
    const target = normalizeSearchText(`${st.name} ${st.merchantUsername} ${st.invoicePrefix} ${st.whatsappNumber} ${st.marketCategory}`);
    return target.includes(qNorm);
  });

  if (filteredStores.length === 0) {
    container.innerHTML = `
      <div class="empty-box glass-panel">
        <i class="ri-store-2-line"></i>
        <span>${qNorm ? "لا توجد متاجر مطابقة لبحثك" : "لا توجد متاجر مسجلة حالياً. أنشئ أول متجر من النموذج أعلاه."}</span>
      </div>
    `;
    return;
  }

  filteredStores.forEach(st => {
    const isExpired = st.subExpiry && st.subExpiry < todayStr;
    const isMaintenance = st.storeStatus === "maintenance" || isExpired;
    const storeProdsCount = saAllProducts.filter(p => p.storeId === st.id).length;
    const storeOrdersCount = saAllOrders.filter(o => o.storeId === st.id).length;
    const storeStaffList = saAllStaff.filter(sf => sf.storeId === st.id);

    const hasPin = st.pinCode && String(st.pinCode).trim() !== "";
    const staffSummaryHtml = storeStaffList.length > 0
      ? storeStaffList.map(sf => `• ${escapeHtml(sf.name)} (${escapeHtml(sf.role)}) — الدخول: <strong dir="ltr">${escapeHtml(sf.username)}</strong> | المرور: <strong dir="ltr">${escapeHtml(sf.password)}</strong> | الرمز (PIN): <strong dir="ltr">${escapeHtml(sf.pinCode || "غير مفعل")}</strong>`).join("<br>")
      : "لا يوجد موظفون مسجلون في هذا المتجر";

    const card = document.createElement("div");
    card.className = "invoice-accordion";
    card.innerHTML = `
      <button type="button" class="invoice-summary-bar">
        <div class="invoice-summary-right">
          <div class="expand-circle"><i class="ri-arrow-down-s-line"></i></div>
          <div>
            <div class="inv-number-title">
              <i class="ri-store-3-fill" style="color:var(--caramel);"></i>
              <span>${escapeHtml(st.name)}</span>
              <small style="color:var(--text-secondary); font-size:0.84rem;">(رمز الفواتير: ${escapeHtml(st.invoicePrefix || "NF")})</small>
            </div>
            <div class="inv-customer-brief">التصنيف: ${escapeHtml(st.marketCategory || "عام")} | المستخدم: <span dir="ltr">${escapeHtml(st.merchantUsername)}</span> | الرمز السريع: <strong style="color:var(--caramel-dark);" dir="ltr">${hasPin ? escapeHtml(st.pinCode) : "غير مفعل"}</strong></div>
            <div class="inv-time-brief">المنتجات: ${storeProdsCount} منتج | الطلبات: ${storeOrdersCount} فاتورة | الموظفون: ${storeStaffList.length}</div>
          </div>
        </div>

        <div class="invoice-summary-left">
          <span class="inv-total-badge">${escapeHtml(st.subPlan || "مجاني")} (${Number(st.subPrice || 0)} ريال)</span>
          <span class="status-badge-lg ${isMaintenance ? 'status-cancel' : 'status-done'}">
            <i class="${isMaintenance ? 'ri-tools-fill' : 'ri-checkbox-circle-fill'}"></i>
            <span>${isMaintenance ? "تحت الصيانة / منتهي" : "نشط ومفعل"}</span>
          </span>
        </div>
      </button>

      <div class="invoice-details-body">
        <div class="inv-info-grid">
          <div class="inv-box glass-inset">
            <h4><i class="ri-key-2-line"></i> بيانات دخول التاجر والرمز السريع (4 أرقام)</h4>
            <div><strong>اسم المستخدم:</strong> <span dir="ltr">${escapeHtml(st.merchantUsername)}</span></div>
            <div><strong>كلمة المرور الأساسية:</strong> <span dir="ltr">${escapeHtml(st.merchantPassword)}</span></div>
            <div style="margin-top:4px; padding:6px 10px; background:rgba(182,123,72,0.14); border-radius:10px;">
              <strong>رمز الدخول السريع (PIN):</strong> 
              <strong style="font-size:1.05rem; color:var(--espresso);" dir="ltr">${hasPin ? escapeHtml(st.pinCode) : "غير مفعل"}</strong>
            </div>
            <div style="margin-top:4px;"><strong>واتساب المتجر:</strong> <span dir="ltr">${escapeHtml(st.whatsappNumber)}</span></div>
          </div>

          <div class="inv-box glass-inset">
            <h4><i class="ri-vip-crown-line"></i> تفاصيل الاشتراك والتشغيل</h4>
            <div><strong>نوع الباقة:</strong> ${escapeHtml(st.subPlan)} (${Number(st.subPrice || 0)} ريال)</div>
            <div><strong>تاريخ الانتهاء:</strong> ${escapeHtml(st.subExpiry || "غير محدد")} ${isExpired ? '<strong style="color:var(--danger);">(منتهي)</strong>' : ''}</div>
            <div><strong>التوصيل الأساسي:</strong> ${Number(st.baseDeliveryFee ?? 15)} ريال | <strong>الحد الأدنى:</strong> ${Number(st.minOrderAmount ?? 0)} ريال</div>
            <div><strong>الأجهزة الموثوقة المسجلة:</strong> ${(st.trustedDevices || []).length} جهاز</div>
          </div>
        </div>

        <div class="inv-box glass-inset">
          <h4><i class="ri-team-line"></i> موظفو ومناديب هذا المتجر ورموزهم السرية</h4>
          <div style="font-size:0.86rem;">${staffSummaryHtml}</div>
        </div>

        <div class="inv-actions-row">
          <button type="button" class="btn-primary-glass manage-full-store-btn">
            <i class="ri-dashboard-3-line"></i>
            <span>الدخول للوحة التاجر وإدارتها بالكامل</span>
          </button>
          <button type="button" class="btn-glass edit-store-btn">
            <i class="ri-edit-2-line"></i>
            <span>تعديل الحساب / الرمز / الاشتراك</span>
          </button>
          <button type="button" class="btn-glass clear-pin-btn">
            <i class="ri-lock-unlock-line"></i>
            <span>تصفير أو تغيير رمز الـ PIN</span>
          </button>
          <button type="button" class="btn-glass toggle-maint-btn">
            <i class="ri-tools-line"></i>
            <span>${st.storeStatus === "maintenance" ? "تفعيل المتجر الآن" : "تحويل للصيانة"}</span>
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

    card.querySelector(".manage-full-store-btn").addEventListener("click", () => {
      confirmAction({
        title: "الدخول الشامل للوحة التاجر",
        message: `سيتم فتح لوحة تحكم متجر "${st.name}" بصلاحية الإدارة العليا لتعديل منتجاته أو طلباته أو موظفيه أو هويته مباشرة. هل تود المتابعة؟`,
        confirmText: "نعم، فتح لوحة المتجر",
        onConfirm: () => enterStoreAsSuperAdmin(st)
      });
    });

    card.querySelector(".edit-store-btn").addEventListener("click", () => {
      document.getElementById("saStoreFormAccordion").classList.add("open");
      document.getElementById("saStoreFormTitle").textContent = `تعديل شامل لمتجر: ${st.name}`;
      document.getElementById("saEditStoreId").value = st.id;
      document.getElementById("saStoreName").value = st.name;
      document.getElementById("saStoreCategory").value = st.marketCategory || saMarketCategories[0];
      document.getElementById("saStorePrefix").value = st.invoicePrefix || "NF";
      document.getElementById("saStoreWhatsapp").value = st.whatsappNumber || "";
      document.getElementById("saMerchantUsername").value = st.merchantUsername || "";
      document.getElementById("saMerchantPassword").value = st.merchantPassword || "";
      document.getElementById("saMerchantPin").value = st.pinCode || "";
      document.getElementById("saBaseDeliveryFee").value = st.baseDeliveryFee ?? 15;
      document.getElementById("saMinOrderAmount").value = st.minOrderAmount ?? 0;
      document.getElementById("saWorkMode").value = st.workMode || "24h";
      document.getElementById("saSubPlan").value = st.subPlan || "مجاني";
      document.getElementById("saSubPrice").value = st.subPrice || 0;
      document.getElementById("saSubExpiry").value = st.subExpiry || "";
      document.getElementById("saStoreStatus").value = st.storeStatus || "active";
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    card.querySelector(".clear-pin-btn").addEventListener("click", () => {
      openSecurityModal({
        title: `تعيين أو مسح رمز التاجر: ${st.name}`,
        desc: `الرمز الحالي للتاجر هو (${st.pinCode || "غير مفعل"}). اكتب 4 أرقام جديدة لتعيينها له، أو اترك الحقل فارغاً واضغط حفظ لإلغاء الرمز عنه:`,
        confirmText: "حفظ الرمز للتاجر",
        onConfirm: async (newMerchantPin) => {
          if (newMerchantPin !== "" && !/^\d{4}$/.test(newMerchantPin)) {
            showToast("يجب كتابة 4 أرقام بالضبط أو ترك الحقل فارغاً لإلغاء الرمز");
            return;
          }
          await updateDoc(doc(db, "nafal_stores", st.id), { pinCode: newMerchantPin });
          closeSecurityModal();
          showToast(newMerchantPin ? `تم تغيير رمز التاجر إلى: ${newMerchantPin}` : "تم إلغاء الرمز السريع عن التاجر بنجاح");
        }
      });
    });

    card.querySelector(".toggle-maint-btn").addEventListener("click", () => {
      const nextStatus = st.storeStatus === "maintenance" ? "active" : "maintenance";
      confirmAction({
        title: nextStatus === "active" ? "تفعيل المتجر في السوق" : "تحويل المتجر لوضع الصيانة",
        message: nextStatus === "active"
          ? `هل أنت متأكد من تفعيل متجر "${st.name}" ليظهر للجمهور؟`
          : `هل أنت متأكد من تحويل متجر "${st.name}" إلى وضع الصيانة؟`,
        confirmText: "نعم، تنفيذ",
        onConfirm: async () => {
          await updateDoc(doc(db, "nafal_stores", st.id), { storeStatus: nextStatus });
          showToast(nextStatus === "active" ? "تم تفعيل المتجر في السوق" : "تم تحويل المتجر لوضع الصيانة");
        }
      });
    });

    // عند حذف متجر، يتم حذف موظفيه أيضاً لتحرير أسماء المستخدمين الخاصة بهم
    card.querySelector(".del-store-btn").addEventListener("click", () => {
      confirmAction({
        title: "حذف المتجر نهائياً",
        message: `تحذير: هل أنت متأكد من حذف متجر "${st.name}" وموظفيه نهائياً من قاعدة البيانات؟`,
        confirmText: "نعم، حذف المتجر",
        isDanger: true,
        onConfirm: async () => {
          for (const sf of storeStaffList) {
            await deleteDoc(doc(db, "nafal_staff", sf.id));
          }
          await deleteDoc(doc(db, "nafal_stores", st.id));
          showToast("تم حذف المتجر وتحرير أسماء المستخدمين المرتبطة به");
        }
      });
    });

    container.appendChild(card);
  });
}

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
          <div style="font-size:1.04rem; font-weight:900;">
            الاسم الحالي: <span style="color:var(--text-secondary);">${escapeHtml(req.oldName)}</span> 
            ⬅️ الاسم الجديد المطلوب: <span style="color:var(--caramel-dark);">${escapeHtml(req.requestedName)}</span>
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
      card.querySelector(".approve-btn").addEventListener("click", () => {
        confirmAction({
          title: "اعتماد الاسم الجديد للمتجر",
          message: `هل توافق على تغيير اسم المتجر من "${req.oldName}" إلى "${req.requestedName}"؟`,
          confirmText: "نعم، موافقة واعتماد",
          onConfirm: async () => {
            await updateDoc(doc(db, "nafal_stores", req.storeId), { name: req.requestedName });
            await updateDoc(doc(db, "nafal_name_requests", req.id), { status: "approved", resolvedAt: Date.now() });
            showToast(`تم اعتماد الاسم الجديد: ${req.requestedName}`);
          }
        });
      });

      card.querySelector(".reject-btn").addEventListener("click", () => {
        confirmAction({
          title: "رفض طلب تغيير الاسم",
          message: `هل أنت متأكد من رفض تغيير اسم المتجر "${req.oldName}"؟`,
          confirmText: "نعم، رفض الطلب",
          isDanger: true,
          onConfirm: async () => {
            await updateDoc(doc(db, "nafal_name_requests", req.id), { status: "rejected", resolvedAt: Date.now() });
            showToast("تم رفض طلب تغيير الاسم");
          }
        });
      });
    }

    container.appendChild(card);
  });
}

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
    statusEl.textContent = "تعذر رفع الشعار — تأكد من صحة مفتاح الـ API";
  }
});

document.getElementById("saPlatformForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!currentSession || currentSession.role !== "superadmin") {
    showToast("غير مصرح لك بتعديل هذه الإعدادات");
    return;
  }

  confirmAction({
    title: "حفظ إعدادات المنصة وخزنة الـ API",
    message: "هل أنت متأكد من حفظ التعديلات على هوية السوق ومفتاح رفع الصور؟",
    confirmText: "نعم، حفظ الإعدادات",
    onConfirm: async () => {
      const newApiKey = document.getElementById("saImgbbApiKeyInput").value.trim() || DEFAULT_IMGBB_KEY;
      const newEndpoint = document.getElementById("saUploadEndpointInput").value.trim() || DEFAULT_UPLOAD_ENDPOINT;

      dynamicImgbbApiKey = newApiKey;
      dynamicUploadEndpoint = newEndpoint;

      await setDoc(doc(db, "nafal_platform", "marketConfig"), {
        showMarketplace: document.getElementById("saShowMarketplaceToggle").checked,
        platformName: document.getElementById("saPlatformName").value.trim(),
        platformSlogan: document.getElementById("saPlatformSlogan").value.trim(),
        platformBanner: document.getElementById("saPlatformBanner").value.trim(),
        platformLogo: document.getElementById("saPlatformLogoUrl").value.trim(),
        imgbbApiKey: newApiKey,
        uploadEndpoint: newEndpoint,
        updatedAt: Date.now()
      }, { merge: true });

      showToast("تم حفظ إعدادات المنصة وخزنة مفتاح الـ API بنجاح");
    }
  });
});

// حفظ بيانات دخول الإدارة العليا مع فحص عدم تكرار اسم المستخدم في النظام
document.getElementById("saCredentialsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const newUser = document.getElementById("saAdminNewUser").value.trim();
  const newPass = document.getElementById("saAdminNewPass").value.trim();
  const newPin = normalizeSearchText(document.getElementById("saAdminPinInput").value);

  if (newPin !== "" && !/^\d{4}$/.test(newPin)) {
    showToast("الرمز السريع يجب أن يتكون من 4 أرقام بالضبط أو اتركه فارغاً لإلغائه");
    return;
  }

  const isTaken = await isUsernameTakenGlobally(newUser, "superadmin", "superAdmin");
  if (isTaken) {
    showToast("اسم المستخدم هذا محجوز ومستخدم حالياً، يرجى اختيار اسم آخر");
    return;
  }

  confirmAction({
    title: "تحديث بيانات دخول الإدارة العليا",
    message: "هل أنت متأكد من حفظ اسم المستخدم، كلمة المرور، والرمز السريع الجديد لحسابك؟",
    confirmText: "نعم، تحديث بياناتي",
    onConfirm: async () => {
      await setDoc(doc(db, "nafal_platform", "superAdmin"), {
        username: newUser,
        password: newPass,
        pinCode: newPin,
        updatedAt: Date.now()
      }, { merge: true });

      currentSession.username = newUser;
      currentSession.pinCode = newPin;
      saveSessionLocally(currentSession);
      document.getElementById("currentUserDisplay").textContent = newUser;
      updateQuickLockButtonVisibility();
      showToast("تم تحديث بيانات الدخول والرمز السريع للإدارة العليا فوراً");
    }
  });
});

document.getElementById("saRevokeAllDevicesBtn").addEventListener("click", () => {
  confirmAction({
    title: "إلغاء الوثوق بجميع الأجهزة",
    message: "هل أنت متأكد من إزالة جميع الأجهزة الموثوقة المسجلة على حساب الإدارة العليا؟",
    confirmText: "نعم، إزالة الكل",
    isDanger: true,
    onConfirm: async () => {
      await updateDoc(doc(db, "nafal_platform", "superAdmin"), { trustedDevices: [] });
      showToast("تم إلغاء الوثوق بجميع الأجهزة");
      performFullLogout();
    }
  });
});
// ============================================================================
// تكملة ملف المحرك الأمني الشامل لبوابة نفال (app.js) — الجزء الثاني (2 / 2)
// الصق هذا الكود مباشرة أسفل نهاية الجزء الأول
// ============================================================================

// القسم الثاني: منطق التاجر (Merchant View - صاحب المتجر) + البحث الذكي الفوري
let mCurrentStore = null;
let mStoreCategories = ["المنتجات المميزة", "بكجات وعروض", "أصناف متنوعة"];
let mUploadedImagesList = [];
let mAllOrders = [];
let mSelectedOrderFilter = "all";
let mOrderSearchQuery = "";

function initMerchantPortal(storeId) {
  const unsubStore = onSnapshot(doc(db, "nafal_stores", storeId), snap => {
    if (!snap.exists()) return;
    mCurrentStore = { id: snap.id, ...snap.data() };
    if (currentSession && currentSession.role === "merchant" && !isSuperAdminManagingStore) {
      currentSession.pinCode = mCurrentStore.pinCode || "";
      updateQuickLockButtonVisibility();
    }
    populateMerchantUI(mCurrentStore);
    renderTrustedDevicesUI("mTrustedDevicesList", mCurrentStore.trustedDevices || [], "merchant", mCurrentStore.id);
  });

  const qProds = query(collection(db, "nafal_products"), where("storeId", "==", storeId));
  const unsubProds = onSnapshot(qProds, snap => {
    const prods = [];
    snap.forEach(d => prods.push({ id: d.id, ...d.data() }));
    prods.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    renderMerchantProducts(prods);
  });

  const qOrders = query(collection(db, "nafal_orders"), where("storeId", "==", storeId));
  const unsubOrders = onSnapshot(qOrders, snap => {
    mAllOrders = [];
    snap.forEach(d => mAllOrders.push({ id: d.id, ...d.data() }));
    mAllOrders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    updateMerchantStatsAndOrders();
  });

  const qStaff = query(collection(db, "nafal_staff"), where("storeId", "==", storeId));
  const unsubStaff = onSnapshot(qStaff, snap => {
    const staffList = [];
    snap.forEach(d => staffList.push({ id: d.id, ...d.data() }));
    renderMerchantStaff(staffList);
  });

  activeUnsubscribers.push(unsubStore, unsubProds, unsubOrders, unsubStaff);
}

// أحداث محرك البحث الذكي في فواتير التاجر
document.getElementById("mOrderSearchInput").addEventListener("input", (e) => {
  mOrderSearchQuery = e.target.value;
  document.getElementById("mClearOrderSearchBtn").classList.toggle("hidden", !mOrderSearchQuery.trim());
  updateMerchantStatsAndOrders();
});

document.getElementById("mClearOrderSearchBtn").addEventListener("click", () => {
  document.getElementById("mOrderSearchInput").value = "";
  mOrderSearchQuery = "";
  document.getElementById("mClearOrderSearchBtn").classList.add("hidden");
  updateMerchantStatsAndOrders();
});

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

  const todayStr = new Date().toISOString().split("T")[0];
  const isExpired = st.subExpiry && st.subExpiry < todayStr;
  document.getElementById("mSubBannerTitle").textContent = 
    `باقة اشتراكك: ${st.subPlan || "مجاني"} (${st.subPrice ? st.subPrice + " ريال" : "مفعل"}) ${isExpired ? "— منتهي (المتجر في وضع الصيانة)" : ""}`;
  document.getElementById("mSubBannerExpiry").innerHTML = 
    `تاريخ الانتهاء: <strong>${escapeHtml(st.subExpiry || "مفتوح")}</strong> | رمز فواتير متجرك: <strong>${escapeHtml(st.invoicePrefix || "NF")}</strong>`;

  const avgRating = st.ratingCount ? (st.ratingSum / st.ratingCount).toFixed(1) : "5.0";
  document.getElementById("mStatRating").textContent = `${avgRating} ★`;

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

  document.getElementById("mSelfNewUser").value = st.merchantUsername || "";
  document.getElementById("mSelfNewPass").value = st.merchantPassword || "";
  document.getElementById("mSelfPinInput").value = st.pinCode || "";

  if (Array.isArray(st.categories) && st.categories.length > 0) {
    mStoreCategories = st.categories;
  }
  renderMerchantCategories();
}

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
    statusEl.textContent = "حدث خطأ أثناء رفع الصور";
  }
});

function renderMerchantUploadedThumbs() {
  const row = document.getElementById("mImagesPreviewRow");
  row.innerHTML = "";
  mUploadedImagesList.forEach((url, idx) => {
    const box = document.createElement("div");
    box.className = "preview-thumb-box";
    box.innerHTML = `
      <img src="${escapeHtml(url)}" alt="صورة">
      <button type="button" title="حذف الصورة">&times;</button>
    `;
    box.querySelector("button").addEventListener("click", () => {
      confirmAction({
        title: "حذف صورة المنتج",
        message: "هل تريد إزالة هذه الصورة من قائمة صور المنتج؟",
        confirmText: "نعم، إزالة",
        isDanger: true,
        onConfirm: () => {
          mUploadedImagesList.splice(idx, 1);
          renderMerchantUploadedThumbs();
        }
      });
    });
    row.appendChild(box);
  });
}

document.getElementById("mProductForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!mCurrentStore) return;

  const editId = document.getElementById("mEditProductId").value.trim();
  const prodNameVal = document.getElementById("mProdName").value.trim();

  confirmAction({
    title: editId ? "تأكيد تحديث المنتج" : "تأكيد إضافة منتج جديد",
    message: editId
      ? `هل أنت متأكد من حفظ التعديلات على المنتج "${prodNameVal}"؟`
      : `هل أنت متأكد من إضافة المنتج "${prodNameVal}" إلى متجرك؟`,
    confirmText: "نعم، حفظ المنتج",
    onConfirm: async () => {
      const images = mUploadedImagesList.length > 0 ? mUploadedImagesList : [DEFAULT_PRODUCT_IMG];

      const prodData = {
        storeId: mCurrentStore.id,
        storeName: mCurrentStore.name,
        name: prodNameVal,
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
    }
  });
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
      <img src="${escapeHtml(p.imageUrl || DEFAULT_PRODUCT_IMG)}" alt="${escapeHtml(p.name)}" loading="lazy">
      <div class="product-card-body">
        <div class="product-card-title">${p.productType === "bundle" ? "🔥 " : ""}${escapeHtml(p.name)}</div>
        <div style="font-size:0.8rem; color:var(--text-secondary); font-weight:700;">
          ${escapeHtml(p.category)} | المخزون: ${Number(p.stock)} | الصور: ${(p.images || []).length || 1}
        </div>
        <div class="product-card-meta">
          <span>${Number(p.price)} ريال ${p.oldPrice ? `<del style="color:var(--text-secondary); font-size:0.78rem;">${Number(p.oldPrice)}</del>` : ""}</span>
          <span style="font-size:0.74rem;">${p.freeDelivery ? "توصيل مجاني" : ""}</span>
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

    card.querySelector(".del-btn").addEventListener("click", () => {
      confirmAction({
        title: "حذف المنتج من المتجر",
        message: `هل أنت متأكد من حذف المنتج "${p.name}" نهائياً من متجرك؟`,
        confirmText: "نعم، حذف المنتج",
        isDanger: true,
        onConfirm: async () => {
          await deleteDoc(doc(db, "nafal_products", p.id));
          showToast("تم حذف المنتج بنجاح");
        }
      });
    });

    container.appendChild(card);
  });
}

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
  const countBadge = document.getElementById("mOrderSearchCountBadge");
  container.innerHTML = "";

  const isSearching = mOrderSearchQuery.trim() !== "";

  const filtered = mAllOrders.filter(order => {
    const matchStatus = mSelectedOrderFilter === "all" || order.status === mSelectedOrderFilter;
    const matchSearch = matchesSmartOrderQuery(order, mOrderSearchQuery);
    return matchStatus && matchSearch;
  });

  if (countBadge) {
    if (isSearching || mSelectedOrderFilter !== "all") {
      countBadge.textContent = `${filtered.length} فاتورة مطابقة`;
    } else {
      countBadge.textContent = `إجمالي الفواتير: ${mAllOrders.length}`;
    }
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-box glass-panel">
        <i class="ri-inbox-2-line"></i>
        <span>${isSearching ? "لا توجد فاتورة مطابقة لبحثك.. جرب البحث بآخر 4 أرقام من الجوال أو الفاتورة" : "لا توجد فواتير في هذا التصنيف حالياً"}</span>
      </div>
    `;
    return;
  }

  filtered.forEach((order, index) => {
    const shouldOpen = (isSearching && index === 0) || (index === 0 && order.status === "جديد - قيد المراجعة");
    container.appendChild(createOrderAccordionCard(order, shouldOpen, true));
  });
}

// بناء بطاقة الفاتورة المنسدلة (مع تأكيد ذكي قبل تغيير الحالة أو الحذف)
function createOrderAccordionCard(order, openByDefault = false, isMerchant = true) {
  const statusMeta = getStatusMeta(order.status);
  const cleanInvoiceNum = (order.invoiceNumber || "").replace(/#/g, "");
  const accordion = document.createElement("div");
  accordion.className = `invoice-accordion ${openByDefault ? "open" : ""}`;

  const itemsHtml = (order.items || []).map(i => `• <strong>${escapeHtml(i.name)}</strong> (الكمية: ${Number(i.qty)} × ${Number(i.price)} ريال)`).join("<br>");
  const customerPhone = (order.customerPhone || "").replace(/[^0-9]/g, "");
  const courierLine = order.courierName ? `\nالمندوب: ${order.courierName} (${order.courierPhone || ""})` : "";
  const waUpdateMsg = encodeURIComponent(
    `مرحباً ${order.customerName}\nتحديث بخصوص فاتورتك رقم (${cleanInvoiceNum}) من ${order.storeName || "متجرنا"}:\nالحالة الآن: *${order.status}*${courierLine}\nالإجمالي: ${order.totalAmount} ريال.`
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
            <span>فاتورة رقم: ${escapeHtml(cleanInvoiceNum)}</span>
          </div>
          <div class="inv-customer-brief">${escapeHtml(order.customerName)} — <span dir="ltr">${escapeHtml(order.customerPhone)}</span></div>
          <div class="inv-time-brief">${new Date(order.createdAt || Date.now()).toLocaleString("ar-SA")}</div>
        </div>
      </div>

      <div class="invoice-summary-left">
        <span class="inv-total-badge">${Number(order.totalAmount)} ريال</span>
        <span class="status-badge-lg ${statusMeta.cssClass}">
          <i class="${statusMeta.icon}"></i>
          <span>${escapeHtml(order.status)}</span>
        </span>
      </div>
    </button>

    <div class="invoice-details-body">
      <div class="status-control-section">
        <div class="status-control-label">
          <i class="ri-exchange-box-line" style="color:var(--caramel); font-size:1.25rem;"></i>
          <span>اضغط لتغيير حالة الفاتورة (تتحدث عند الزبون فوراً):</span>
        </div>

        <div class="status-dropdown-wrapper">
          <button type="button" class="status-dropdown-trigger">
            <span>الحالة الحالية: ${escapeHtml(order.status)}</span>
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
          <div><strong>الاسم:</strong> ${escapeHtml(order.customerName)}</div>
          <div><strong>الجوال:</strong> <a href="tel:${escapeHtml(order.customerPhone)}" style="color:var(--espresso); font-weight:900;" dir="ltr">${escapeHtml(order.customerPhone)}</a></div>
          <div><strong>العنوان:</strong> ${escapeHtml(order.customerAddress || "داخل شرورة")}</div>
          ${order.courierName ? `<div><strong>المندوب المستلم:</strong> ${escapeHtml(order.courierName)} (${escapeHtml(order.courierPhone)})</div>` : ""}
        </div>

        <div class="inv-box glass-inset">
          <h4><i class="ri-shopping-bag-3-line"></i> الطلبات</h4>
          <div>${itemsHtml}</div>
          <div style="margin-top:8px; padding-top:8px; border-top:1px dashed rgba(30,19,13,0.15); font-weight:900;">
            التوصيل: ${Number(order.deliveryFee)} ريال | الإجمالي: ${Number(order.totalAmount)} ريال
          </div>
        </div>
      </div>

      <div class="inv-actions-row">
        <a href="https://wa.me/${customerPhone}?text=${waUpdateMsg}" target="_blank" class="whatsapp-btn-lg">
          <i class="ri-whatsapp-line"></i>
          <span>إشعار الزبون عبر واتساب</span>
        </a>
        ${order.gpsLocation ? `
          <a href="${escapeHtml(order.gpsLocation)}" target="_blank" class="gps-btn-lg">
            <i class="ri-map-pin-2-fill"></i>
            <span>فتح موقع الزبون (GPS)</span>
          </a>
        ` : ""}
        ${isMerchant ? `
          <button type="button" class="btn-danger-glass del-order-btn">
            <i class="ri-delete-bin-line"></i>
            <span>حذف الفاتورة</span>
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
    optBtn.addEventListener("click", () => {
      const newStatus = optBtn.dataset.val;
      dropdownWrap.classList.remove("open");
      if (newStatus === order.status) return;

      confirmAction({
        title: "تأكيد تغيير حالة الفاتورة",
        message: `هل أنت متأكد من تغيير حالة الفاتورة (${cleanInvoiceNum}) الخاصة بالعميل "${order.customerName}" إلى "${newStatus}"؟`,
        confirmText: "نعم، تحديث الحالة",
        isDanger: newStatus === "ملغي",
        onConfirm: async () => {
          const updatePayload = {
            status: newStatus,
            updatedAt: Date.now()
          };

          if (currentSession && currentSession.role === "staff" && newStatus === "مع المندوب للتوصيل") {
            updatePayload.courierName = currentSession.name;
            updatePayload.courierPhone = currentSession.phone;
          }

          await updateDoc(doc(db, "nafal_orders", order.id), updatePayload);
          showToast(`تم تحديث الفاتورة ${cleanInvoiceNum} إلى: ${newStatus}`);
        }
      });
    });
  });

  const delBtn = accordion.querySelector(".del-order-btn");
  if (delBtn) {
    delBtn.addEventListener("click", () => {
      confirmAction({
        title: "حذف الفاتورة نهائياً",
        message: `هل أنت متأكد من حذف الفاتورة رقم (${cleanInvoiceNum}) نهائياً من السجل؟`,
        confirmText: "نعم، حذف الفاتورة",
        isDanger: true,
        onConfirm: async () => {
          await deleteDoc(doc(db, "nafal_orders", order.id));
          showToast("تم حذف الفاتورة");
        }
      });
    });
  }

  return accordion;
}

document.getElementById("mWorkOffersForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!mCurrentStore) return;

  confirmAction({
    title: "حفظ أوقات الدوام وعروض التوصيل",
    message: "هل أنت متأكد من حفظ التغييرات على ساعات الدوام والحد الأدنى ورسوم التوصيل لمتجرك؟",
    confirmText: "نعم، حفظ الإعدادات",
    onConfirm: async () => {
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
    }
  });
});

// إدارة الموظفين والمناديب (مع فحص عدم تكرار اسم المستخدم في كل النظام)
document.getElementById("mStaffForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!mCurrentStore) return;

  const editStaffId = document.getElementById("mEditStaffId").value.trim();
  const staffNameVal = document.getElementById("mStaffName").value.trim();
  const candidateStaffUser = document.getElementById("mStaffUsername").value.trim();
  const staffPinVal = normalizeSearchText(document.getElementById("mStaffPin")?.value || "");

  if (staffPinVal !== "" && !/^\d{4}$/.test(staffPinVal)) {
    showToast("رمز الدخول السريع للموظف يجب أن يكون 4 أرقام أو اتركه فارغاً");
    return;
  }

  // فحص عدم تكرار اسم المستخدم مع الإدارة أو التجار أو أي موظف آخر
  const isTaken = await isUsernameTakenGlobally(candidateStaffUser, "staff", editStaffId || null);
  if (isTaken) {
    showToast("اسم المستخدم هذا محجوز ومستخدم حالياً، يرجى اختيار اسم آخر");
    return;
  }

  confirmAction({
    title: editStaffId ? "تأكيد تحديث بيانات الموظف" : "تأكيد إضافة موظف جديد",
    message: editStaffId
      ? `هل أنت متأكد من حفظ التعديلات على حساب الموظف "${staffNameVal}"؟`
      : `هل أنت متأكد من إنشاء حساب للموظف/المندوب "${staffNameVal}"؟`,
    confirmText: "نعم، حفظ الموظف",
    onConfirm: async () => {
      const payload = {
        storeId: mCurrentStore.id,
        storeName: mCurrentStore.name,
        name: staffNameVal,
        phone: document.getElementById("mStaffPhone").value.trim(),
        role: document.getElementById("mStaffRole").value,
        username: candidateStaffUser,
        password: document.getElementById("mStaffPassword").value.trim(),
        pinCode: staffPinVal,
        updatedAt: Date.now()
      };

      if (editStaffId) {
        await updateDoc(doc(db, "nafal_staff", editStaffId), payload);
        showToast("تم تحديث بيانات الموظف ورمزه السريع");
      } else {
        payload.createdAt = Date.now();
        payload.trustedDevices = [];
        await addDoc(collection(db, "nafal_staff"), payload);
        showToast("تمت إضافة الموظف بنجاح");
      }
      document.getElementById("mStaffForm").reset();
      document.getElementById("mEditStaffId").value = "";
    }
  });
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
          <strong style="font-size:1.04rem;">${escapeHtml(sf.name)} (${escapeHtml(sf.role)})</strong>
          <div class="sub-hint">
            جوال: <span dir="ltr">${escapeHtml(sf.phone)}</span> | 
            اسم الدخول: <strong dir="ltr">${escapeHtml(sf.username)}</strong> | 
            كلمة المرور: <strong dir="ltr">${escapeHtml(sf.password)}</strong> | 
            الرمز السريع (PIN): <strong style="color:var(--caramel-dark);" dir="ltr">${escapeHtml(sf.pinCode || "غير مفعل")}</strong>
          </div>
        </div>
        <div style="display:flex; gap:8px;">
          <button type="button" class="btn-glass edit-sf-btn"><i class="ri-edit-line"></i> تعديل / تغيير الرمز</button>
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
      const pinField = document.getElementById("mStaffPin");
      if (pinField) pinField.value = sf.pinCode || "";
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    card.querySelector(".del-sf-btn").addEventListener("click", () => {
      confirmAction({
        title: "حذف حساب الموظف",
        message: `هل أنت متأكد من حذف حساب الموظف "${sf.name}" نهائياً؟ (سيصبح اسم المستخدم متاحاً من جديد)`,
        confirmText: "نعم، حذف الموظف",
        isDanger: true,
        onConfirm: async () => {
          await deleteDoc(doc(db, "nafal_staff", sf.id));
          showToast("تم حذف الموظف وتحرير اسم المستخدم");
        }
      });
    });

    container.appendChild(card);
  });
}

document.getElementById("mSendNameRequestBtn").addEventListener("click", () => {
  if (!mCurrentStore) return;
  const newName = document.getElementById("mRequestedStoreName").value.trim();
  if (!newName) return showToast("اكتب الاسم الجديد المقترح أولاً");

  if (isSuperAdminManagingStore) {
    confirmAction({
      title: "تغيير فوري لاسم المتجر (صلاحية الإدارة العليا)",
      message: `بصفتك الإدارة العليا، هل تريد تغيير اسم المتجر فوراً إلى "${newName}"؟`,
      confirmText: "نعم، تغيير الاسم فوراً",
      onConfirm: async () => {
        await updateDoc(doc(db, "nafal_stores", mCurrentStore.id), { name: newName });
        document.getElementById("mRequestedStoreName").value = "";
        showToast(`تم تغيير اسم المتجر فوراً إلى: ${newName}`);
      }
    });
    return;
  }

  confirmAction({
    title: "إرسال طلب تغيير اسم المتجر",
    message: `هل تريد رفع طلب رسمي لتغيير اسم متجرك إلى "${newName}" لمراجعته من إدارة المنصة؟`,
    confirmText: "نعم، إرسال الطلب",
    onConfirm: async () => {
      await addDoc(collection(db, "nafal_name_requests"), {
        storeId: mCurrentStore.id,
        oldName: mCurrentStore.name,
        requestedName: newName,
        status: "pending",
        createdAt: Date.now()
      });

      document.getElementById("mRequestedStoreName").value = "";
      document.getElementById("mPendingNameHint").textContent = `تم إرسال طلب تغيير الاسم إلى "${newName}" للمراجعة.`;
      showToast("تم إرسال طلب تغيير الاسم للمراجعة");
    }
  });
});

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

document.getElementById("mIdentityForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!mCurrentStore) return;

  confirmAction({
    title: "حفظ هوية المتجر وموقع المحل",
    message: "هل أنت متأكد من حفظ التعديلات على الشعار والوصف وأرقام التواصل وموقع المحل؟",
    confirmText: "نعم، حفظ الهوية",
    onConfirm: async () => {
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
    }
  });
});

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
      <span><i class="ri-price-tag-3-line" style="color:var(--caramel); margin-left:8px;"></i>${escapeHtml(cat)}</span>
      <button type="button" class="btn-danger-glass"><i class="ri-delete-bin-line"></i></button>
    `;
    li.querySelector("button").addEventListener("click", () => {
      if (mStoreCategories.length <= 1) return showToast("يجب بقاء قسم واحد على الأقل");
      confirmAction({
        title: "حذف قسم من المتجر",
        message: `هل أنت متأكد من حذف القسم "${cat}" من متجرك؟`,
        confirmText: "نعم، حذف القسم",
        isDanger: true,
        onConfirm: async () => {
          mStoreCategories.splice(idx, 1);
          await updateDoc(doc(db, "nafal_stores", mCurrentStore.id), { categories: mStoreCategories });
          showToast("تم حذف القسم");
        }
      });
    });
    list.appendChild(li);
  });
}

document.getElementById("mAddCatBtn").addEventListener("click", () => {
  if (!mCurrentStore) return;
  const input = document.getElementById("mNewCatInput");
  const val = input.value.trim();
  if (!val) return;
  if (!mStoreCategories.includes(val)) {
    confirmAction({
      title: "إضافة قسم جديد للمتجر",
      message: `هل تريد إضافة القسم "${val}" إلى أقسام متجرك؟`,
      confirmText: "نعم، إضافة",
      onConfirm: async () => {
        mStoreCategories.push(val);
        await updateDoc(doc(db, "nafal_stores", mCurrentStore.id), { categories: mStoreCategories });
        input.value = "";
        showToast("تمت إضافة القسم لمتجرك");
      }
    });
  }
});

// تحديث بيانات دخول التاجر والرمز السريع (مع فحص عدم تكرار اسم المستخدم في كل النظام)
document.getElementById("mCredentialsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!mCurrentStore) return;
  const newUser = document.getElementById("mSelfNewUser").value.trim();
  const newPass = document.getElementById("mSelfNewPass").value.trim();
  const newPin = normalizeSearchText(document.getElementById("mSelfPinInput").value);

  if (newPin !== "" && !/^\d{4}$/.test(newPin)) {
    showToast("الرمز السريع يجب أن يتكون من 4 أرقام بالضبط أو اتركه فارغاً");
    return;
  }

  const isTaken = await isUsernameTakenGlobally(newUser, "merchant", mCurrentStore.id);
  if (isTaken) {
    showToast("اسم المستخدم هذا محجوز ومستخدم حالياً، يرجى اختيار اسم آخر");
    return;
  }

  confirmAction({
    title: "تحديث بيانات الأمان والرمز السريع",
    message: "هل أنت متأكد من حفظ التعديلات على اسم المستخدم وكلمة المرور والرمز السريع؟",
    confirmText: "نعم، حفظ التعديلات",
    onConfirm: () => {
      requirePinVerification(async () => {
        await updateDoc(doc(db, "nafal_stores", mCurrentStore.id), {
          merchantUsername: newUser,
          merchantPassword: newPass,
          pinCode: newPin
        });

        if (!isSuperAdminManagingStore) {
          currentSession.username = newUser;
          currentSession.pinCode = newPin;
          saveSessionLocally(currentSession);
          document.getElementById("currentUserDisplay").textContent = newUser;
          updateQuickLockButtonVisibility();
        }
        showToast("تم تحديث بيانات الأمان والرمز السريع للمتجر");
      }, "أدخل رمزك السريع الحالي لتأكيد تعديل بيانات الأمان:");
    }
  });
});

document.getElementById("mRevokeAllDevicesBtn").addEventListener("click", () => {
  if (!mCurrentStore) return;
  confirmAction({
    title: "إلغاء الوثوق بجميع أجهزة المتجر",
    message: "هل أنت متأكد من إزالة جميع الأجهزة الموثوقة المسجلة على هذا المتجر؟",
    confirmText: "نعم، إزالة الكل",
    isDanger: true,
    onConfirm: async () => {
      await updateDoc(doc(db, "nafal_stores", mCurrentStore.id), { trustedDevices: [] });
      showToast("تم إلغاء الوثوق بجميع الأجهزة المسجلة على المتجر");
      if (!isSuperAdminManagingStore) performFullLogout();
    }
  });
});

// ============================================================================
// القسم الثالث: منطق الموظف / مندوب التوصيل (Staff / Courier View) + البحث الذكي
// ============================================================================
let staffOrdersList = [];
let staffFilterMode = "active";
let staffOrderSearchQuery = "";

function initStaffPortal(session) {
  document.getElementById("portalTitle").textContent = `مهام: ${session.name}`;
  document.getElementById("portalSubtitle").textContent = `${session.staffRole} — صلاحية متابعة وتوصيل الطلبات فقط`;
  document.getElementById("staffWelcomeTitle").textContent = `أهلاً بك يا ${session.name} (${session.staffRole})`;

  const unsubStaffDoc = onSnapshot(doc(db, "nafal_staff", session.docId), snap => {
    if (!snap.exists()) return;
    const sf = snap.data();
    document.getElementById("staffPinInput").value = sf.pinCode || "";
    if (currentSession && currentSession.role === "staff") {
      currentSession.pinCode = sf.pinCode || "";
      updateQuickLockButtonVisibility();
    }
    renderTrustedDevicesUI("staffTrustedDevicesList", sf.trustedDevices || [], "staff", session.docId);
  });

  const qOrders = query(collection(db, "nafal_orders"), where("storeId", "==", session.storeId));
  const unsubOrders = onSnapshot(qOrders, snap => {
    staffOrdersList = [];
    snap.forEach(d => staffOrdersList.push({ id: d.id, ...d.data() }));
    staffOrdersList.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    renderStaffOrders();
  });

  activeUnsubscribers.push(unsubStaffDoc, unsubOrders);
}

// البحث الذكي في طلبات المندوب
document.getElementById("staffOrderSearchInput").addEventListener("input", (e) => {
  staffOrderSearchQuery = e.target.value;
  document.getElementById("staffClearOrderSearchBtn").classList.toggle("hidden", !staffOrderSearchQuery.trim());
  renderStaffOrders();
});

document.getElementById("staffClearOrderSearchBtn").addEventListener("click", () => {
  document.getElementById("staffOrderSearchInput").value = "";
  staffOrderSearchQuery = "";
  document.getElementById("staffClearOrderSearchBtn").classList.add("hidden");
  renderStaffOrders();
});

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

  const filtered = staffOrdersList.filter(o => {
    const matchTab = staffFilterMode === "active"
      ? (o.status !== "تم التوصيل" && o.status !== "ملغي")
      : (o.status === "تم التوصيل");
    const matchSearch = matchesSmartOrderQuery(o, staffOrderSearchQuery);
    return matchTab && matchSearch;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-box glass-panel">
        <i class="ri-e-bike-2-line"></i>
        <span>${staffOrderSearchQuery.trim() ? "لا توجد طلبات مطابقة لبحثك" : "لا توجد طلبات في هذه القائمة حالياً"}</span>
      </div>
    `;
    return;
  }

  filtered.forEach((order, idx) => {
    container.appendChild(createOrderAccordionCard(order, idx === 0, false));
  });
}

document.getElementById("staffPinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!currentSession || currentSession.role !== "staff") return;
  const newPin = normalizeSearchText(document.getElementById("staffPinInput").value);

  if (newPin !== "" && !/^\d{4}$/.test(newPin)) {
    showToast("الرمز السريع يجب أن يتكون من 4 أرقام بالضبط أو اتركه فارغاً");
    return;
  }

  confirmAction({
    title: "حفظ الرمز السريع للمندوب",
    message: "هل أنت متأكد من حفظ الرمز السريع الجديد الخاص بك؟",
    confirmText: "نعم، حفظ الرمز",
    onConfirm: async () => {
      await updateDoc(doc(db, "nafal_staff", currentSession.docId), { pinCode: newPin });
      currentSession.pinCode = newPin;
      saveSessionLocally(currentSession);
      updateQuickLockButtonVisibility();
      showToast("تم حفظ الرمز السريع الخاص بك بنجاح");
    }
  });
});

document.getElementById("staffRevokeAllDevicesBtn").addEventListener("click", () => {
  if (!currentSession || currentSession.role !== "staff") return;
  confirmAction({
    title: "إلغاء الوثوق بجميع أجهزتك",
    message: "هل أنت متأكد من إزالة جميع أجهزتك الموثوقة وتسجيل الخروج؟",
    confirmText: "نعم، إزالة الكل",
    isDanger: true,
    onConfirm: async () => {
      await updateDoc(doc(db, "nafal_staff", currentSession.docId), { trustedDevices: [] });
      showToast("تم إلغاء الوثوق بجميع أجهزتك");
      performFullLogout();
    }
  });
});

// بدء تشغيل البوابة عبر شاشة فحص وتأمين الجلسة الذكية
verifySavedSessionOnStartup();
