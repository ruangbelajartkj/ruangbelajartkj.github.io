const GOOGLE_SHEETS_URL = 'https://script.google.com/macros/s/AKfycbwe687AAhBUUL3O_ByN2xALgfs9NbH_-oMKwglYxqSbtr8pDHPBfzA5Cmjk--bL1OqW/exec'; // Isi dengan URL Web App Google Apps Script.
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'tjkt2025';
const DEFAULT_QUIZ_DURATION = 15;
const QUIZ_DATE_KEY = 'ruangkelas.quizDate';
const QUIZ_MAPEL_KEY = 'ruangkelas.quizMapel';

const QUIZ_SCHEDULES_KEY = 'ruangkelas.quizSchedules';
const MATERIALS_KEY = 'ruangkelas.materials';
const MATERIALS_DB_NAME = 'ruangkelas.db';
const MATERIALS_STORE_NAME = 'materials';
const LANDING_CONTENT_KEY = 'ruangkelas.landingContent';
const defaultLandingContent = {
  eyebrow: 'SMK • Teknik Jaringan Komputer & Telekomunikasi',
  title: 'Belajar jaringan.\nBangun masa depan.',
  description: 'Jurusan TJKT membekali siswa dengan keterampilan jaringan komputer, server, keamanan siber, dan teknologi telekomunikasi untuk menghadapi dunia industri.',
  button: 'Mulai belajar',
  image: ''
};
let remoteMaterialsLoaded = false;
let remoteConfigAvailable = false;
let connectionStatus = 'loading'; // loading, connected, offline
let lastSyncTime = null;

function updateConnectionStatus(status, message = '') {
  connectionStatus = status;
  const badge = document.getElementById('connection-status');
  if (!badge) return;
  
  badge.classList.remove('connection-loading', 'connection-connected', 'connection-offline');
  badge.classList.add(`connection-${status}`);
  
  if (status === 'loading') {
    badge.innerHTML = '<span></span> Menghubungkan...';
    badge.title = 'Menyambung ke server...';
  } else if (status === 'connected') {
    badge.innerHTML = '<span></span> Tersambung';
    badge.title = `Server terkoneksi${lastSyncTime ? ' • Diperbarui: ' + lastSyncTime : ''}`;
  } else {
    badge.innerHTML = '<span></span> Offline';
    badge.title = 'Menggunakan data lokal (offline)';
  }
}

function updateSyncIndicator(syncing = false) {
  const indicator = document.getElementById('sync-indicator');
  if (!indicator) return;
  
  if (syncing) {
    indicator.classList.remove('synced');
    indicator.classList.add('syncing');
    indicator.textContent = '⟳ Sinkronisasi...';
  } else {
    indicator.classList.remove('syncing');
    indicator.classList.add('synced');
    indicator.textContent = '✓ Sinkron';
  }
}

// Toast Notification System
function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div class="toast-message">${message}</div>`;
  
  container.appendChild(toast);
  
  // Auto remove after duration
  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// URL Validation
function isValidUrl(urlString) {
  const value = urlString.trim();
  if (!value) return false;

  if (value.startsWith('gs://') || value.startsWith('drive.google.com')) return true;
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return true;

  const relativePathPattern = /^(?:[A-Za-z0-9._\-/]+\.[A-Za-z0-9]+|[A-Za-z0-9._\-/]+)$/;
  if (relativePathPattern.test(value) && (value.includes('/') || value.includes('.') || value.includes('\\'))) {
    return true;
  }

  try {
    const url = new URL(value, window.location.origin);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'file:';
  } catch (_) {
    return false;
  }
}

function normalizeMaterialLinks(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  return value
    .split(/\r?\n|,/) 
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => item !== '|' && item !== ';');
}

// Material Validation
function validateMaterial(judul, deskripsi, link) {
  const links = normalizeMaterialLinks(link);

  if (!judul || judul.trim().length < 3) {
    showToast('Judul materi minimal 3 karakter', 'error');
    return false;
  }
  if (!deskripsi || deskripsi.trim().length < 10) {
    showToast('Deskripsi materi minimal 10 karakter', 'error');
    return false;
  }
  if (!links.length) {
    showToast('Link materi harus diisi', 'error');
    return false;
  }
  const invalidLink = links.find(item => !isValidUrl(item));
  if (invalidLink) {
    showToast('Format link tidak valid. Gunakan URL atau Google Drive link', 'error');
    return false;
  }
  return true;
}

// Set button loading state
function setButtonLoading(button, isLoading) {
  if (!button) return;
  if (isLoading) {
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.textContent = '⟳ Menyimpan...';
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalText || 'Simpan';
  }
}

function getMaterialSignature(material = {}) {
  const linkValue = Array.isArray(material.link) ? material.link.join('|') : (material.link || '');
  return `${(material.mapel || '').toLowerCase()}::${(material.judul || '').trim().toLowerCase()}::${linkValue.trim().toLowerCase()}`;
}

function normalizeMaterialForStorage(material = {}) {
  const normalized = { ...material };
  delete normalized.source;
  delete normalized.createdAt;
  if (Array.isArray(normalized.link)) {
    normalized.link = normalized.link.filter(Boolean);
  }
  return normalized;
}

function mergeMaterials(localItems = [], remoteItems = []) {
  const merged = new Map();
  const localArray = Array.isArray(localItems) ? localItems : [];
  const remoteArray = Array.isArray(remoteItems) ? remoteItems : [];

  localArray.forEach(item => {
    const normalized = { ...item, source: item.source || 'local' };
    merged.set(getMaterialSignature(normalized), normalized);
  });

  remoteArray.forEach(item => {
    const normalized = { ...item, source: 'server' };
    const key = getMaterialSignature(normalized);
    const existing = merged.get(key);

    if (!existing || existing.source !== 'server') {
      merged.set(key, normalized);
      return;
    }

    if ((normalized.createdAt || '') > (existing.createdAt || '')) {
      merged.set(key, normalized);
    }
  });

  return [...merged.values()].map(item => ({
    ...item,
    source: item.source === 'server' ? 'server' : (item.source || 'local')
  }));
}

async function loadRemoteConfig() {
  if (!GOOGLE_SHEETS_URL) return;
  
  updateSyncIndicator(true);
  try {
    // Tambah timeout 5 detik agar tidak menunggu terlalu lama
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timeout')), 5000)
    );
    
    const response = await Promise.race([
      fetch(`${GOOGLE_SHEETS_URL}?action=config&t=${Date.now()}`, { cache: 'no-store' }),
      timeoutPromise
    ]);
    
    const json = await response.json();
    if (!json.success || !json.data) throw new Error('Deployment Apps Script belum diperbarui.');
    remoteConfigAvailable = true;
    const data = json.data || {};
    if (data.landingContent) localStorage.setItem(LANDING_CONTENT_KEY, JSON.stringify(data.landingContent));
    if (Array.isArray(data.materials)) {
      const localSavedMaterials = (await getSavedMaterials()) || [];
      const remoteMaterials = data.materials.map(m => {
        const sanitized = normalizeMaterialForStorage(m);
        return { ...sanitized, source: 'server' };
      });
      const mergedMaterials = mergeMaterials(localSavedMaterials, remoteMaterials);
      localStorage.setItem(MATERIALS_KEY, JSON.stringify(mergedMaterials));
      allMateri = mergedMaterials;
      remoteMaterialsLoaded = true;
    }
    if (Array.isArray(data.quizSchedules)) {
      localStorage.setItem(QUIZ_SCHEDULES_KEY, JSON.stringify(data.quizSchedules));
      if (data.quizSchedules[0]) {
        localStorage.setItem(QUIZ_DATE_KEY, data.quizSchedules[0].date);
        localStorage.setItem(QUIZ_MAPEL_KEY, data.quizSchedules[0].mapel);
      }
    }
    updateQuizScheduleInfo();
    renderLandingContent();
    await loadMateri();
    
    // Update status koneksi
    updateConnectionStatus('connected');
    updateSyncIndicator(false);
    lastSyncTime = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  } catch (error) {
    const hasLocalData = Boolean(
      localStorage.getItem(MATERIALS_KEY) ||
      localStorage.getItem(LANDING_CONTENT_KEY) ||
      allMateri.length
    );

    if (hasLocalData) {
      updateConnectionStatus('connected');
      updateSyncIndicator(false);
      return;
    }

    updateConnectionStatus('offline');
    updateSyncIndicator(false);
  }
}

async function saveRemoteConfig(key, value) {
  if (!GOOGLE_SHEETS_URL) {
    console.error('URL Web App Google Apps Script belum diatur.');
    return false;
  }

  try {
    await fetch(GOOGLE_SHEETS_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'saveConfig', key, value })
    });
    remoteConfigAvailable = true;
    return true;
  } catch (error) {
    console.error('Gagal menyimpan data ke Sheet:', error);
  }
  return false;
}
const fallbackMateri = [
  { mapel: 'KJR', judul: 'Prinsip Keamanan Jaringan', deskripsi: 'Bangun kebiasaan aman untuk melindungi data dan infrastruktur digital.', link: 'materi/prinsip-keamanan-jaringan.pdf', level: 'Menengah', source: 'local' },
  { mapel: 'PKPJ', judul: 'Pemasangan dan Konfigurasi Perangkat Jaringan', deskripsi: 'Pelajari pemasangan kabel, konfigurasi perangkat, dan pengujian koneksi jaringan.', link: 'materi/pemasangan-konfigurasi-perangkat-jaringan.pdf', level: 'Pemula', source: 'local' },
  { mapel: 'TJKDN', judul: 'Teknologi Jaringan Kabel dan Nirkabel', deskripsi: 'Pelajari media transmisi kabel, jaringan Wi-Fi, dan teknologi penghubung perangkat.', link: '#', level: 'Pemula', source: 'local' }
];
const fallbackKuis = {
  KJR: [
    { soal: 'Kepanjangan dari CIA dalam keamanan informasi adalah...', opsi: ['Control, Internet, Access', 'Confidentiality, Integrity, Availability', 'Cipher, Identity, Authentication', 'Cloud, Infrastructure, Application'], jawaban: 1 },
    { soal: 'Confidentiality berarti informasi hanya dapat diakses oleh...', opsi: ['Semua orang', 'Pihak yang berwenang', 'Mesin pencari', 'Tamu jaringan'], jawaban: 1 },
    { soal: 'Integrity dalam keamanan informasi berarti data...', opsi: ['Selalu tersedia', 'Tidak berubah tanpa izin', 'Boleh dibagikan bebas', 'Disimpan tanpa nama'], jawaban: 1 },
    { soal: 'Availability berarti informasi dan layanan...', opsi: ['Tersedia saat dibutuhkan', 'Selalu dirahasiakan', 'Tidak boleh dicadangkan', 'Hanya berada offline'], jawaban: 0 },
    { soal: 'Upaya menipu pengguna agar memberikan data rahasia disebut...', opsi: ['Phishing', 'Routing', 'Hashing', 'Patching'], jawaban: 0 },
    { soal: 'Program berbahaya yang mengunci file dan meminta tebusan disebut...', opsi: ['Spyware', 'Ransomware', 'Adware', 'Firmware'], jawaban: 1 },
    { soal: 'Perangkat lunak untuk menyaring lalu lintas jaringan disebut...', opsi: ['Firewall', 'Compiler', 'Text editor', 'Bootloader'], jawaban: 0 },
    { soal: 'Proses mengubah data menjadi bentuk tidak terbaca tanpa kunci disebut...', opsi: ['Enkripsi', 'Kompresi', 'Fragmentasi', 'Rendering'], jawaban: 0 },
    { soal: 'Password yang baik seharusnya...', opsi: ['Pendek dan mudah ditebak', 'Menggunakan kombinasi karakter', 'Sama untuk semua akun', 'Berisi nama sendiri'], jawaban: 1 },
    { soal: 'Autentikasi dua faktor menambahkan...', opsi: ['Lapisan verifikasi kedua', 'Dua username yang sama', 'Dua koneksi internet', 'Dua antivirus tanpa konfigurasi'], jawaban: 0 },
    { soal: 'Malware yang memata-matai aktivitas pengguna disebut...', opsi: ['Spyware', 'Routerware', 'Shareware', 'Middleware'], jawaban: 0 },
    { soal: 'Serangan yang membanjiri server dengan banyak permintaan disebut...', opsi: ['DDoS', 'DNS', 'DHCP', 'DLP'], jawaban: 0 },
    { soal: 'Data cadangan digunakan untuk...', opsi: ['Memulihkan data saat terjadi kerusakan', 'Membuat password terlihat', 'Menonaktifkan firewall', 'Menghapus log keamanan'], jawaban: 0 },
    { soal: 'Pembaruan keamanan penting dilakukan untuk...', opsi: ['Menutup kerentanan', 'Mengurangi kapasitas RAM', 'Menghapus semua pengguna', 'Mengganti jenis monitor'], jawaban: 0 },
    { soal: 'Teknik mendapatkan akses dengan mencoba banyak password disebut...', opsi: ['Brute force', 'Port forwarding', 'Load balancing', 'Data mining'], jawaban: 0 },
    { soal: 'VPN digunakan untuk membuat...', opsi: ['Koneksi privat melalui jaringan publik', 'Kabel jaringan baru', 'Akun tanpa password', 'Virus yang aman'], jawaban: 0 },
    { soal: 'Hasil hash umumnya digunakan untuk...', opsi: ['Memverifikasi integritas data', 'Mengirim listrik', 'Mengganti alamat MAC', 'Membuat kabel crossover'], jawaban: 0 },
    { soal: 'Prinsip memberikan hak akses secukupnya disebut...', opsi: ['Least privilege', 'Open access', 'Full sharing', 'Public default'], jawaban: 0 },
    { soal: 'Log keamanan berguna untuk...', opsi: ['Mencatat dan menelusuri aktivitas', 'Menambah kecepatan kipas', 'Mengubah resolusi layar', 'Menghapus bukti serangan'], jawaban: 0 },
    { soal: 'Social engineering menyerang...', opsi: ['Manusia dan perilakunya', 'Hanya kabel fiber', 'Hanya prosesor', 'Sistem pendingin'], jawaban: 0 }
  ],
  PKPJ: [
    { soal: 'Perangkat yang menghubungkan beberapa komputer dalam satu LAN adalah...', opsi: ['Switch', 'Printer', 'Scanner', 'UPS'], jawaban: 0 },
    { soal: 'Alat untuk memasang konektor RJ45 pada kabel UTP disebut...', opsi: ['Tang crimping', 'Obeng plus', 'Multimeter', 'Kunci inggris'], jawaban: 0 },
    { soal: 'Kabel yang digunakan untuk menghubungkan komputer ke switch adalah...', opsi: ['Straight-through', 'Rollover', 'Kabel listrik', 'Kabel telepon'], jawaban: 0 },
    { soal: 'Urutan standar kabel straight-through pada kedua ujungnya adalah...', opsi: ['T568A-T568A atau T568B-T568B', 'T568A-T568B saja', 'RJ11-RJ11', 'USB-USB'], jawaban: 0 },
    { soal: 'Perintah Cisco IOS untuk masuk ke mode konfigurasi global adalah...', opsi: ['configure terminal', 'enable password', 'show ip route', 'copy run start'], jawaban: 0 },
    { soal: 'Perintah untuk memberi nama pada perangkat Cisco adalah...', opsi: ['hostname', 'device-name', 'setname', 'router-title'], jawaban: 0 },
    { soal: 'Perintah untuk memberi alamat IP pada interface router adalah...', opsi: ['ip address', 'address ip', 'set ip', 'interface address'], jawaban: 0 },
    { soal: 'Setelah memberi IP pada interface Cisco, perintah untuk mengaktifkannya adalah...', opsi: ['no shutdown', 'interface on', 'enable port', 'start interface'], jawaban: 0 },
    { soal: 'Perintah untuk menyimpan konfigurasi router adalah...', opsi: ['copy running-config startup-config', 'save router', 'store config', 'write file'], jawaban: 0 },
    { soal: 'Alamat IP 192.168.10.1 termasuk alamat...', opsi: ['Private', 'Broadcast publik', 'Loopback saja', 'Multicast'], jawaban: 0 },
    { soal: 'DHCP berfungsi untuk...', opsi: ['Memberikan IP secara otomatis', 'Menghubungkan kabel', 'Menguji tegangan', 'Menghapus VLAN'], jawaban: 0 },
    { soal: 'Access point digunakan untuk menyediakan koneksi...', opsi: ['Nirkabel', 'Listrik', 'Serial printer', 'Telepon analog'], jawaban: 0 },
    { soal: 'Perintah untuk menguji koneksi ke perangkat lain adalah...', opsi: ['ping', 'format', 'mkdir', 'rename'], jawaban: 0 },
    { soal: 'Lampu indikator link pada switch mati biasanya menunjukkan...', opsi: ['Tidak ada koneksi fisik', 'IP terlalu cepat', 'DNS aktif', 'Password benar'], jawaban: 0 },
    { soal: 'Alat untuk menguji susunan kabel UTP disebut...', opsi: ['LAN tester', 'Access point', 'Router', 'Patch panel'], jawaban: 0 },
    { soal: 'VLAN digunakan untuk...', opsi: ['Membagi jaringan secara logis', 'Mengganti konektor', 'Menguatkan listrik', 'Menghapus alamat IP'], jawaban: 0 },
    { soal: 'Default gateway pada komputer digunakan untuk...', opsi: ['Mengakses jaringan lain', 'Mencetak dokumen', 'Mengatur brightness', 'Membuat kabel'], jawaban: 0 },
    { soal: 'Perintah Cisco untuk melihat status interface adalah...', opsi: ['show ip interface brief', 'show interfaces off', 'display port all', 'list network'], jawaban: 0 },
    { soal: 'Kabel fiber optic mengirimkan data menggunakan...', opsi: ['Cahaya', 'Arus AC', 'Gelombang suara', 'Medan magnet saja'], jawaban: 0 },
    { soal: 'Tahap terakhir setelah konfigurasi perangkat jaringan adalah...', opsi: ['Pengujian koneksi dan dokumentasi', 'Mencabut semua kabel', 'Menghapus konfigurasi', 'Mematikan perangkat'], jawaban: 0 }
  ],
  TJKDN: [
    { soal: 'Media transmisi yang menggunakan pulsa cahaya untuk mengirim data adalah...', opsi: ['Kabel fiber optic', 'Kabel coaxial', 'Kabel UTP', 'Gelombang radio'], jawaban: 0 },
    { soal: 'Kabel UTP umumnya menggunakan konektor...', opsi: ['RJ45', 'RJ11', 'USB-C', 'HDMI'], jawaban: 0 },
    { soal: 'Perangkat yang menyediakan akses jaringan Wi-Fi disebut...', opsi: ['Access point', 'Patch panel', 'Repeater pasif', 'Tang crimping'], jawaban: 0 },
    { soal: 'Teknologi Wi-Fi menggunakan media transmisi berupa...', opsi: ['Gelombang radio', 'Cahaya tampak', 'Arus listrik langsung', 'Serat kaca'], jawaban: 0 },
    { soal: 'Kabel twisted pair dipilin untuk mengurangi...', opsi: ['Interferensi elektromagnetik', 'Kapasitas penyimpanan', 'Kecepatan prosesor', 'Panjang alamat IP'], jawaban: 0 },
    { soal: 'SSID pada jaringan nirkabel digunakan sebagai...', opsi: ['Nama jaringan Wi-Fi', 'Kata sandi router', 'Alamat fisik kabel', 'Jenis konektor'], jawaban: 0 },
    { soal: 'Perangkat yang memperkuat atau meneruskan sinyal jaringan disebut...', opsi: ['Repeater', 'Printer', 'Scanner', 'Firewall'], jawaban: 0 },
    { soal: 'Standar keamanan Wi-Fi yang lebih kuat daripada WEP adalah...', opsi: ['WPA2', 'FTP', 'HTTP', 'VGA'], jawaban: 0 },
    { soal: 'Alat untuk menguji kontinuitas dan susunan kabel jaringan adalah...', opsi: ['LAN tester', 'Access point', 'Modem', 'Switch unmanaged'], jawaban: 0 },
    { soal: 'Kelebihan utama jaringan nirkabel dibanding kabel adalah...', opsi: ['Mobilitas pengguna', 'Selalu lebih cepat', 'Tidak memerlukan keamanan', 'Tidak dipengaruhi jarak'], jawaban: 0 }
  ]
};
let allMateri = fallbackMateri;
let currentKuisData = [];
let currentQuestion = 0;
let score = 0;
let selectedAnswers = [];
let timerId = null;
let remainingSeconds = DEFAULT_QUIZ_DURATION;
let editingMaterialIndex = null;
let editingQuizScheduleIndex = null;
const mapelNames = { KJR: 'Keamanan', PKPJ: 'Pemasangan perangkat', TJKDN: 'Kabel dan nirkabel' };

async function loadMateri() {
  const savedMaterials = remoteMaterialsLoaded ? null : await getSavedMaterials();
  if (savedMaterials) allMateri = savedMaterials;
  updateModuleCount();
  if (!document.getElementById('materi-container')) return;
  renderMateri();
  updateQuizScheduleInfo();
}

function updateModuleCount() {
  const jumlahModul = document.getElementById('jumlah-modul');
  if (jumlahModul) jumlahModul.textContent = allMateri.length;
}

function getLandingContent() {
  try {
    return { ...defaultLandingContent, ...(JSON.parse(localStorage.getItem(LANDING_CONTENT_KEY)) || {}) };
  } catch (err) {
    return defaultLandingContent;
  }
}

function renderLandingContent() {
  const content = getLandingContent();
  const eyebrow = document.getElementById('landing-eyebrow');
  const title = document.getElementById('landing-title');
  const description = document.getElementById('landing-description');
  const button = document.getElementById('landing-button');
  const image = document.getElementById('landing-image');
  const placeholder = document.getElementById('landing-placeholder');
  if (eyebrow) eyebrow.textContent = content.eyebrow;
  if (title) {
    const titleLines = content.title.split(/\r?\n/);
    title.textContent = titleLines[0] || '';
    if (titleLines[1]) {
      title.append(document.createElement('br'));
      const accent = document.createElement('span');
      accent.textContent = titleLines.slice(1).join(' ');
      title.append(accent);
    }
  }
  if (description) description.textContent = content.description;
  if (button) button.innerHTML = `${content.button} <span>→</span>`;
  if (image && placeholder) {
    image.src = content.image;
    image.classList.toggle('hidden', !content.image);
    placeholder.classList.toggle('hidden', Boolean(content.image));
  }
}

async function saveLandingContent() {
  const imageInput = document.getElementById('landing-image-file');
  const content = {
    eyebrow: document.getElementById('landing-eyebrow-input').value.trim(),
    title: document.getElementById('landing-title-input').value.trim(),
    description: document.getElementById('landing-description-input').value.trim(),
    button: document.getElementById('landing-button-input').value.trim() || 'Mulai belajar',
    image: getLandingContent().image
  };
  if (!content.eyebrow || !content.title || !content.description) return alert('Eyebrow, judul, dan deskripsi wajib diisi.');
  if (imageInput.files[0]) {
    const reader = new FileReader();
    reader.onload = async () => {
      content.image = reader.result;
      localStorage.setItem(LANDING_CONTENT_KEY, JSON.stringify(content));
      await saveRemoteConfig('landingContent', content);
      renderLandingContent();
      alert('Konten landing page berhasil disimpan.');
    };
    reader.readAsDataURL(imageInput.files[0]);
    return;
  }
  localStorage.setItem(LANDING_CONTENT_KEY, JSON.stringify(content));
  await saveRemoteConfig('landingContent', content);
  renderLandingContent();
  alert('Konten landing page berhasil disimpan.');
}

function resetLandingContent() {
  if (!confirm('Kembalikan landing page ke konten bawaan?')) return;
  localStorage.removeItem(LANDING_CONTENT_KEY);
  saveRemoteConfig('landingContent', defaultLandingContent);
  loadLandingEditor();
  renderLandingContent();
  alert('Landing page dikembalikan ke konten bawaan.');
}

function loadLandingEditor() {
  const content = getLandingContent();
  const eyebrow = document.getElementById('landing-eyebrow-input');
  if (!eyebrow) return;
  eyebrow.value = content.eyebrow;
  document.getElementById('landing-title-input').value = content.title;
  document.getElementById('landing-description-input').value = content.description;
  document.getElementById('landing-button-input').value = content.button;
}

function openMaterialsDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('Penyimpanan file tidak tersedia di browser ini.'));
      return;
    }
    const request = indexedDB.open(MATERIALS_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(MATERIALS_STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Database materi tidak dapat dibuka.'));
  });
}

async function getSavedMaterials() {
  try {
    const database = await openMaterialsDb();
    const materials = await new Promise((resolve, reject) => {
      const request = database.transaction(MATERIALS_STORE_NAME, 'readonly')
        .objectStore(MATERIALS_STORE_NAME).get(MATERIALS_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (materials) return materials;
  } catch (err) {}

  try {
    const saved = localStorage.getItem(MATERIALS_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch (err) {
    return null;
  }
}

async function saveMaterials() {
  const storageData = allMateri.map(normalizeMaterialForStorage);

  try {
    const database = await openMaterialsDb();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(MATERIALS_STORE_NAME, 'readwrite');
      transaction.objectStore(MATERIALS_STORE_NAME).put(storageData, MATERIALS_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Penyimpanan dibatalkan.'));
    });
    database.close();
    await saveRemoteConfig('materials', storageData);
    return true;
  } catch (err) {
    try {
      localStorage.setItem(MATERIALS_KEY, JSON.stringify(storageData));
      await saveRemoteConfig('materials', storageData);
      return true;
    } catch (storageError) {
      alert('Materi gagal disimpan. File terlalu besar atau penyimpanan browser penuh.');
      return false;
    }
  }
}

function openMaterialLink(url, event) {
  if (!url || url === '#') return true;

  const normalizedUrl = String(url).toLowerCase();
  const isPdf = normalizedUrl.endsWith('.pdf') || normalizedUrl.includes('application/pdf') || normalizedUrl.startsWith('data:application/pdf');

  if (!isPdf) return true;

  event?.preventDefault();
  const pdfWindow = window.open('', '_blank', 'width=1200,height=900');

  if (!pdfWindow) {
    window.location.href = url;
    return false;
  }

  pdfWindow.document.write(`<!DOCTYPE html>
    <html lang="id">
      <head>
        <meta charset="UTF-8">
        <title>Preview materi</title>
        <style>
          html, body { margin: 0; height: 100%; background: #1d1d1d; }
          body { display: flex; }
          iframe { width: 100%; height: 100%; border: 0; background: white; }
        </style>
      </head>
      <body>
        <iframe src="${url}" title="Preview materi" type="application/pdf"></iframe>
      </body>
    </html>`);
  pdfWindow.document.close();
  return false;
}

function getMaterialLinks(material) {
  const links = normalizeMaterialLinks(material.link);
  return links.length ? links : [material.link || '#'];
}

function renderMateri() {
  updateModuleCount();
  if (!document.getElementById('materi-container')) return;
  const query = document.getElementById('search-materi')?.value.toLowerCase() || '';
  const filter = document.getElementById('filter-mapel')?.value || 'all';
  const items = allMateri.filter(m => (filter === 'all' || m.mapel === filter) && `${m.judul} ${m.deskripsi}`.toLowerCase().includes(query));
  document.getElementById('materi-container').innerHTML = items.length ? items.map(m => { 
    const index = allMateri.indexOf(m);
    const isServerRecord = m.source === 'server' || (remoteMaterialsLoaded && m.source !== 'local');
    const sourceClass = isServerRecord ? 'source-server' : 'source-local';
    const sourceLabel = isServerRecord ? 'Server' : 'Lokal';
    const sourceBadge = `<span class="tag source-badge ${sourceClass}">${sourceLabel}</span>`;
    const adminActions = `<div class="material-actions admin-only"><button onclick="openMaterialEditor(${index})" title="Edit materi">✎ Edit</button><button onclick="deleteMaterial(${index})" title="Hapus materi">✕ Hapus</button></div>`;
    const links = getMaterialLinks(m);
    const linksHtml = links.map((link, idx) => {
      const label = links.length > 1 ? `Buka materi ${idx + 1}` : 'Buka materi';
      return `<a href="${link}" target="_blank" rel="noopener noreferrer" onclick="return openMaterialLink(this.href, event)">${label} &nbsp;→</a>`;
    }).join('');
    return `<article class="material"><div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px"><span class="tag">${mapelNames[m.mapel] || m.mapel}</span>${sourceBadge}</div><h3>${m.judul}</h3><p>${m.deskripsi}</p><div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center">${linksHtml}</div>${adminActions}</article>`; 
  }).join('') : '<p style="color:var(--muted)">Materi tidak ditemukan.</p>';
}

function renderMaterialsTable() {
  const tbody = document.getElementById('materi-table-body');
  const emptyMsg = document.getElementById('materi-empty-message');
  if (!tbody) return;
  
  if (allMateri.length === 0) {
    tbody.innerHTML = '';
    if (emptyMsg) emptyMsg.style.display = 'block';
    return;
  }
  
  if (emptyMsg) emptyMsg.style.display = 'none';
  
  tbody.innerHTML = allMateri.map((m, index) => {
    const mapelLabel = mapelNames[m.mapel] || m.mapel;
    const sourceLabel = m.source === 'local' ? 'Lokal' : 'Server';
    const mapelClass = `mapel-${m.mapel.toLowerCase()}`;
    const sourceClass = m.source === 'local' ? 'source-lokal' : 'source-server';
    
    return `<tr>
      <td>${index + 1}</td>
      <td><strong>${m.judul}</strong></td>
      <td><span class="mapel-badge ${mapelClass}">${mapelLabel}</span></td>
      <td><span class="source-badge ${sourceClass}">${sourceLabel}</span></td>
      <td><div class="action-buttons">
        <button class="btn-edit" onclick="openMaterialEditor(${index})" title="Edit materi">✎ Edit</button>
        <button class="btn-delete" onclick="deleteMaterial(${index})" title="Hapus materi">✕ Hapus</button>
      </div></td>
    </tr>`;
  }).join('');
}

async function addLocalMaterials(files) {
  if (!files?.length) return;
  const mapel = document.getElementById('upload-mapel')?.value || 'KJR';
  const fileReaders = Array.from(files).map(file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      mapel,
      judul: file.name.replace(/\.[^/.]+$/, ''),
      deskripsi: `File lokal ${file.name}.`,
      link: reader.result,
      source: 'local'
    });
    reader.onerror = () => reject(new Error(`File ${file.name} tidak dapat dibaca.`));
    reader.readAsDataURL(file);
  }));
  try {
    const materials = await Promise.all(fileReaders);
    allMateri.push(...materials);
    if (!await saveMaterials()) {
      allMateri.splice(-materials.length, materials.length);
      return;
    }
    renderMateri();
    renderMaterialsTable();
    displayMaterialInfo();
    alert(`${materials.length} materi berhasil disimpan.`);
    document.getElementById('file-materi').value = '';
  } catch (err) {
    document.getElementById('file-materi').value = '';
    alert(err.message || 'Materi gagal diunggah.');
  }
}

function ensureMaterialLinkEditor() {
  const editor = document.getElementById('material-editor');
  if (!editor) return;

  let container = document.getElementById('material-links-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'material-links-container';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '8px';
    editor.appendChild(container);
  }

  const firstInput = container.querySelector('.material-link-input');
  if (!firstInput) {
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.gap = '8px';

    const input = document.createElement('input');
    input.id = 'editor-link';
    input.type = 'url';
    input.className = 'material-link-input';
    input.placeholder = 'Link file atau Google Drive';
    input.setAttribute('aria-label', 'Link materi');

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.textContent = 'Hapus';
    removeButton.className = 'cancel-button';
    removeButton.onclick = () => wrapper.remove();

    wrapper.appendChild(input);
    wrapper.appendChild(removeButton);
    container.appendChild(wrapper);
  }

  let label = document.getElementById('material-link-label');
  if (!label) {
    label = document.createElement('label');
    label.id = 'material-link-label';
    label.textContent = 'Link materi';
    label.style.fontWeight = '600';
    label.style.color = 'var(--ink)';
  }

  let button = document.getElementById('material-link-add-button');
  if (!button) {
    button = document.createElement('button');
    button.id = 'material-link-add-button';
    button.type = 'button';
    button.className = 'upload-button';
    button.textContent = '+ Link lain';
    button.style.padding = '6px 10px';
    button.style.minHeight = 'auto';
    button.onclick = addMaterialLinkField;
  }

  const header = document.getElementById('material-link-header');
  if (!header) {
    const headerRow = document.createElement('div');
    headerRow.id = 'material-link-header';
    headerRow.style.display = 'flex';
    headerRow.style.alignItems = 'center';
    headerRow.style.justifyContent = 'space-between';
    headerRow.style.gap = '8px';
    headerRow.style.marginTop = '8px';
    headerRow.appendChild(label);
    headerRow.appendChild(button);
    editor.insertBefore(headerRow, container);
  }
}

function addMaterialLinkField() {
  const container = document.getElementById('material-links-container');
  if (!container) return;

  const wrapper = document.createElement('div');
  wrapper.style.display = 'flex';
  wrapper.style.alignItems = 'center';
  wrapper.style.gap = '8px';
  wrapper.style.marginTop = '8px';

  const input = document.createElement('input');
  input.type = 'url';
  input.className = 'material-link-input';
  input.placeholder = 'Link lain';
  input.setAttribute('aria-label', 'Link lain materi');

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.textContent = 'Hapus';
  removeButton.className = 'cancel-button';
  removeButton.onclick = () => wrapper.remove();

  wrapper.appendChild(input);
  wrapper.appendChild(removeButton);
  container.appendChild(wrapper);
  input.focus();
}

function getMaterialLinkInputs() {
  const container = document.getElementById('material-links-container');
  if (!container) return [];

  const values = [];
  container.querySelectorAll('.material-link-input').forEach(input => {
    const value = input.value.trim();
    if (value) values.push(value);
  });
  return values;
}

function resetMaterialLinkInputs(links = []) {
  const container = document.getElementById('material-links-container');
  if (!container) return;

  const values = Array.isArray(links) ? links : [links];
  container.innerHTML = '';

  if (!values.length || !values[0]) {
    const input = document.createElement('input');
    input.id = 'editor-link';
    input.className = 'material-link-input';
    input.type = 'url';
    input.placeholder = 'Link file atau Google Drive';
    input.setAttribute('aria-label', 'Link materi');
    container.appendChild(input);
    return;
  }

  values.forEach((link, index) => {
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.gap = '8px';
    wrapper.style.marginTop = index === 0 ? '0' : '8px';

    const input = document.createElement('input');
    input.type = 'url';
    input.className = 'material-link-input';
    input.value = link;
    input.placeholder = index === 0 ? 'Link file atau Google Drive' : 'Link lain';
    input.setAttribute('aria-label', index === 0 ? 'Link materi' : 'Link lain materi');

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.textContent = 'Hapus';
    removeButton.className = 'cancel-button';
    removeButton.onclick = () => {
      const row = removeButton.parentElement;
      row.remove();
    };

    wrapper.appendChild(input);
    wrapper.appendChild(removeButton);
    container.appendChild(wrapper);
  });
}

function openMaterialEditor(index = null) {
  editingMaterialIndex = index;
  const material = index === null ? {} : allMateri[index];
  const linksValue = Array.isArray(material.link) ? material.link : (material.link ? [material.link] : []);
  ensureMaterialLinkEditor();
  document.getElementById('editor-title').textContent = index === null ? 'Tambah materi' : 'Edit materi';
  document.getElementById('editor-judul').value = material.judul || '';
  document.getElementById('editor-deskripsi').value = material.deskripsi || '';
  document.getElementById('editor-mapel').value = material.mapel || 'KJR';
  resetMaterialLinkInputs(linksValue);
  document.getElementById('material-editor').classList.remove('hidden');
  document.getElementById('editor-judul').focus();
}

function closeMaterialEditor() {
  editingMaterialIndex = null;
  resetMaterialLinkInputs([]);
  document.getElementById('material-editor').classList.add('hidden');
}

async function saveMaterial() {
  const judul = document.getElementById('editor-judul').value.trim();
  const deskripsi = document.getElementById('editor-deskripsi').value.trim();
  const links = normalizeMaterialLinks(getMaterialLinkInputs());
  const mapel = document.getElementById('editor-mapel').value;
  
  // Validate input
  if (!validateMaterial(judul, deskripsi, links)) return;
  
  // Set loading state
  const saveBtn = document.querySelector('.save-button');
  setButtonLoading(saveBtn, true);
  
  try {
    const material = { mapel, judul, deskripsi, link: links.length > 1 ? links : links[0], source: 'local', createdAt: new Date().toISOString() };
    const isEditing = editingMaterialIndex !== null;
    
    if (isEditing) {
      // Preserve original createdAt if updating
      if (allMateri[editingMaterialIndex].createdAt) {
        material.createdAt = allMateri[editingMaterialIndex].createdAt;
      }
      allMateri[editingMaterialIndex] = material;
    } else {
      allMateri.push(material);
    }
    
    // Save to storage
    if (!await saveMaterials()) {
      showToast('Gagal menyimpan materi. Silakan coba lagi', 'error');
      return;
    }
    
    closeMaterialEditor();
    renderMateri();
    renderMaterialsTable();
    displayMaterialInfo();
    showToast(isEditing ? 'Materi berhasil diperbarui' : 'Materi berhasil ditambahkan', 'success');
  } catch (error) {
    showToast(`Error: ${error.message}`, 'error');
  } finally {
    setButtonLoading(saveBtn, false);
  }
}

async function deleteMaterial(index) {
  const material = allMateri[index];
  if (!material) return;
  
  // Confirmation
  if (!confirm(`Yakin hapus materi "${material.judul}"?\n\nTindakan ini tidak dapat dibatalkan.`)) return;
  
  try {
    allMateri.splice(index, 1);
    if (!await saveMaterials()) {
      allMateri.splice(index, 0, material); // Restore if failed
      showToast('Gagal menghapus materi. Silakan coba lagi', 'error');
      return;
    }
    renderMateri();
    renderMaterialsTable();
    displayMaterialInfo();
    showToast(`Materi "${material.judul}" berhasil dihapus`, 'success');
  } catch (error) {
    showToast(`Error: ${error.message}`, 'error');
  }
}

// Export materi ke JSON
function exportMaterials() {
  try {
    const dataStr = JSON.stringify(allMateri, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `materi_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast(`${allMateri.length} materi berhasil diekspor`, 'success');
  } catch (error) {
    showToast(`Gagal mengekspor: ${error.message}`, 'error');
  }
}

// Import materi dari JSON
function importMaterials() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      
      if (!Array.isArray(imported)) throw new Error('Format file tidak valid');
      
      // Validate structure
      const valid = imported.every(m => m.judul && m.deskripsi && m.link && m.mapel);
      if (!valid) throw new Error('Beberapa materi tidak memiliki data lengkap');
      
      if (!confirm(`Import ${imported.length} materi?\n\nMateri yang sudah ada akan dipertahankan.`)) return;
      
      // Add imported materials with source: 'imported'
      const newMaterials = imported.map(m => ({
        ...m,
        source: m.source || 'imported',
        createdAt: m.createdAt || new Date().toISOString()
      }));
      
      allMateri.push(...newMaterials);
      
      if (!await saveMaterials()) {
        allMateri.splice(-newMaterials.length, newMaterials.length);
        throw new Error('Gagal menyimpan materi');
      }
      
      renderMateri();
      displayMaterialInfo();
      showToast(`${imported.length} materi berhasil diimpor`, 'success');
    } catch (error) {
      showToast(`Error import: ${error.message}`, 'error');
    }
  };
  input.click();
}

// Get material statistics
function getMaterialStats() {
  return {
    total: allMateri.length,
    byMapel: {
      'KJR': allMateri.filter(m => m.mapel === 'KJR').length,
      'PKPJ': allMateri.filter(m => m.mapel === 'PKPJ').length,
      'TJKDN': allMateri.filter(m => m.mapel === 'TJKDN').length
    },
    bySource: {
      'server': allMateri.filter(m => m.source === 'server').length,
      'local': allMateri.filter(m => m.source === 'local' || m.source === 'imported').length
    }
  };
}

// Display material management info
function displayMaterialInfo() {
  const stats = getMaterialStats();
  const adminPanel = document.getElementById('admin-panel');
  if (adminPanel) {
    const infoDiv = adminPanel.querySelector('div:first-child');
    if (infoDiv) {
      const info = `Total: <strong>${stats.total}</strong> | KJR: <strong>${stats.byMapel.KJR}</strong> | PKPJ: <strong>${stats.byMapel.PKPJ}</strong> | TJKDN: <strong>${stats.byMapel.TJKDN}</strong>`;
      infoDiv.innerHTML = `<div><strong>Panel admin - Materi</strong><span>${info}</span></div>`;
    }
  }
  
  // Update stats di admin.html
  const statTotal = document.getElementById('stat-total');
  const statKjr = document.getElementById('stat-kjr');
  const statPkpj = document.getElementById('stat-pkpj');
  const statTjkdn = document.getElementById('stat-tjkdn');
  if (statTotal) statTotal.textContent = stats.total;
  if (statKjr) statKjr.textContent = stats.byMapel.KJR;
  if (statPkpj) statPkpj.textContent = stats.byMapel.PKPJ;
  if (statTjkdn) statTjkdn.textContent = stats.byMapel.TJKDN;
}

function addPkpjOptions() {
  const options = {
    'filter-mapel': [['PKPJ', 'Pemasangan perangkat jaringan'], ['TJKDN', 'Kabel dan nirkabel']],
    'editor-mapel': [['PKPJ', 'Pemasangan perangkat jaringan'], ['TJKDN', 'Kabel dan nirkabel']],
    'upload-mapel': [['PKPJ', 'Pemasangan perangkat jaringan'], ['TJKDN', 'Kabel dan nirkabel']],
    'select-mapel': [['PKPJ', 'Pemasangan dan Konfigurasi Perangkat Jaringan'], ['TJKDN', 'Teknologi Jaringan Kabel dan Nirkabel']]
  };
  Object.entries(options).forEach(([selectId, optionList]) => {
    const select = document.getElementById(selectId);
    if (!select) return;
    optionList.forEach(([value, label]) => {
      if (!select.querySelector(`option[value="${value}"]`)) select.add(new Option(label, value));
    });
  });
}

function addUploadMapelSelect() {
  const fileInput = document.getElementById('file-materi');
  if (!fileInput || document.getElementById('upload-mapel')) return;
  const select = document.createElement('select');
  select.id = 'upload-mapel';
  select.className = 'filter';
  select.setAttribute('aria-label', 'Mata pelajaran materi');
  select.add(new Option('Keamanan jaringan', 'KJR'));
  fileInput.closest('label').before(select);
}

function restrictClassOptions() {
  const classSelect = document.getElementById('kelas-siswa');
  if (!classSelect) return;
  Array.from(classSelect.options).forEach(option => {
    if (option.value.startsWith('X TKJ') || option.value.startsWith('XI TKJ')) option.remove();
  });
}

function updateMainNavigation() {
  document.querySelector('a[href="#materi"]')?.setAttribute('href', 'materi.html');
  document.querySelector('a[href="#kuis"]')?.setAttribute('href', 'kuis.html');
}

function toggleAdminLogin() {
  const modal = document.getElementById('admin-login');
  modal.classList.toggle('hidden');
  if (!modal.classList.contains('hidden')) document.getElementById('admin-username').focus();
}

function ensureInfoAdminMenu() {
  if (document.getElementById('admin-panel')) return;
  const pageMain = document.querySelector('main.page-main');
  if (!pageMain) return;
  const panel = document.createElement('section');
  panel.id = 'admin-panel';
  panel.className = 'admin-panel';
  panel.innerHTML = '<div><strong>Panel admin aktif</strong><span>Kelola materi dan jadwal kuis pembelajaran.</span></div><a class="button" href="admin.html">Buka menu admin</a>';
  pageMain.insertBefore(panel, pageMain.querySelector('.info-panel'));
}

function loginAdmin(event) {
  event.preventDefault();
  const username = document.getElementById('admin-username').value.trim();
  const password = document.getElementById('admin-password').value;
  const error = document.getElementById('login-error');
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    error.textContent = 'Username atau password admin salah.';
    error.className = 'login-error';
    return;
  }
  document.getElementById('admin-login').classList.add('hidden');
  document.getElementById('admin-panel')?.classList.remove('hidden');
  ensureInfoAdminMenu();
  document.body.classList.add('admin-mode');
  document.getElementById('profile-button').classList.add('admin-active');
  document.getElementById('profile-button').setAttribute('aria-label', 'Admin aktif');
  const quizDateInput = document.getElementById('quiz-date');
  if (quizDateInput) quizDateInput.value = getQuizDate();
  loadLandingEditor();
  renderMateri();
  displayMaterialInfo();
  showToast('Login admin berhasil', 'success');
}

function getQuizDate() {
  return getActiveQuizSchedule()?.date || '';
}

function getQuizSchedules() {
  try {
    const saved = JSON.parse(localStorage.getItem(QUIZ_SCHEDULES_KEY) || 'null');
    if (Array.isArray(saved)) return saved.filter(schedule => schedule.date && schedule.mapel);
  } catch (err) {}
  const date = localStorage.getItem(QUIZ_DATE_KEY);
  return date ? [{ date, mapel: localStorage.getItem(QUIZ_MAPEL_KEY) || 'KJR' }] : [];
}

function getActiveQuizSchedule() {
  const schedules = getQuizSchedules().sort((first, second) => first.date.localeCompare(second.date));
  return schedules.find(schedule => schedule.date === getTodayDate())
    || schedules.find(schedule => schedule.date > getTodayDate())
    || schedules[schedules.length - 1]
    || null;
}

function getQuizScheduleForMapel(mapel) {
  const schedules = getQuizSchedules().filter(schedule => schedule.mapel === mapel)
    .sort((first, second) => first.date.localeCompare(second.date));
  return schedules.find(schedule => schedule.date === getTodayDate())
    || schedules.find(schedule => schedule.date > getTodayDate())
    || schedules[schedules.length - 1]
    || null;
}

function saveQuizSchedules(schedules) {
  const validSchedules = schedules.filter(schedule => schedule.date && schedule.mapel)
    .sort((first, second) => first.date.localeCompare(second.date));
  if (validSchedules.length) {
    localStorage.setItem(QUIZ_SCHEDULES_KEY, JSON.stringify(validSchedules));
    localStorage.setItem(QUIZ_DATE_KEY, validSchedules[0].date);
    localStorage.setItem(QUIZ_MAPEL_KEY, validSchedules[0].mapel);
  } else {
    localStorage.removeItem(QUIZ_SCHEDULES_KEY);
    localStorage.removeItem(QUIZ_DATE_KEY);
    localStorage.removeItem(QUIZ_MAPEL_KEY);
  }
  saveRemoteConfig('quizSchedules', validSchedules);
}

function getQuizMapelName(mapel) {
  return { KJR: 'Keamanan Jaringan', PKPJ: 'Pemasangan dan Konfigurasi Perangkat Jaringan', TJKDN: 'Teknologi Jaringan Kabel dan Nirkabel' }[mapel] || mapel;
}

function ensureQuizMapelControl() {
  const dateInput = document.getElementById('quiz-date');
  if (!dateInput || document.getElementById('quiz-mapel')) return;
  const select = document.createElement('select');
  select.id = 'quiz-mapel';
  select.setAttribute('aria-label', 'Mata pelajaran kuis');
  select.innerHTML = '<option value="KJR">Keamanan Jaringan</option><option value="PKPJ">Pemasangan dan Konfigurasi Perangkat Jaringan</option><option value="TJKDN">Teknologi Jaringan Kabel dan Nirkabel</option>';
  dateInput.parentElement.parentElement.insertBefore(select, dateInput.parentElement);
  const label = document.createElement('label');
  label.htmlFor = 'quiz-mapel';
  label.textContent = 'Mata pelajaran kuis';
  dateInput.parentElement.parentElement.insertBefore(label, select);
}

function loadQuizScheduleRows() {
  const schedules = getQuizSchedules();
  if (!document.getElementById('quiz-date')) return;
  const firstSchedule = schedules[0] || {};
  document.getElementById('quiz-date').value = firstSchedule.date || '';
  document.getElementById('quiz-mapel').value = firstSchedule.mapel || 'KJR';
}

function renderAdminQuizSchedules() {
  const setting = document.querySelector('.quiz-schedule-setting');
  if (!setting) return;
  let list = document.getElementById('admin-quiz-schedule-list');
  if (!list) {
    list = document.createElement('div');
    list.id = 'admin-quiz-schedule-list';
    list.style.display = 'grid';
    list.style.gap = '8px';
    setting.append(list);
  }
  list.innerHTML = '';
  getQuizSchedules().forEach((schedule, index) => {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px;background:var(--paper);border:1px solid var(--line);border-radius:7px';
    item.innerHTML = `<span><strong>${getQuizMapelName(schedule.mapel)}</strong><br><small>${formatQuizDate(schedule.date)}</small></span><span style="display:flex;gap:6px"><button class="cancel-button" type="button">Edit</button><button class="cancel-button" type="button">Hapus</button></span>`;
    item.querySelectorAll('button')[0].addEventListener('click', () => {
      editingQuizScheduleIndex = index;
      document.getElementById('quiz-date').value = schedule.date;
      document.getElementById('quiz-mapel').value = schedule.mapel;
      document.getElementById('quiz-date').focus();
    });
    item.querySelectorAll('button')[1].addEventListener('click', () => deleteQuizSchedule(index));
    list.append(item);
  });
}

function deleteQuizSchedule(index) {
  const schedules = getQuizSchedules();
  if (!schedules[index] || !confirm(`Hapus jadwal ${getQuizMapelName(schedules[index].mapel)}?`)) return;
  schedules.splice(index, 1);
  editingQuizScheduleIndex = null;
  saveQuizSchedules(schedules);
  loadQuizScheduleRows();
  renderAdminQuizSchedules();
  updateQuizScheduleInfo();
}

function saveQuizDate() {
  const date = document.getElementById('quiz-date').value;
  const mapel = document.getElementById('quiz-mapel')?.value || 'KJR';
  if (!date) return alert('Pilih tanggal jadwal terlebih dahulu.');
  const schedules = getQuizSchedules();
  if (editingQuizScheduleIndex !== null && schedules[editingQuizScheduleIndex]) {
    schedules[editingQuizScheduleIndex] = { date, mapel };
  } else {
    const existingIndex = schedules.findIndex(schedule => schedule.date === date && schedule.mapel === mapel);
    if (existingIndex >= 0) schedules[existingIndex] = { date, mapel };
    else schedules.push({ date, mapel });
  }
  editingQuizScheduleIndex = null;
  saveQuizSchedules(schedules);
  alert(`Jadwal ${getQuizMapelName(mapel)} disimpan. Total jadwal: ${schedules.length}.`);
  loadQuizScheduleRows();
  renderAdminQuizSchedules();
  updateQuizScheduleInfo();
}

async function loginAdminPage(event) {
  event.preventDefault();
  const username = document.getElementById('admin-page-username').value.trim();
  const password = document.getElementById('admin-page-password').value;
  const error = document.getElementById('admin-page-login-error');
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    error.textContent = 'Username atau password admin salah.';
    error.className = 'login-error';
    return;
  }
  document.getElementById('admin-access').classList.add('hidden');
  document.getElementById('admin-dashboard').classList.remove('hidden');
  ensureQuizMapelControl();
  loadQuizScheduleRows();
  renderAdminQuizSchedules();
  await loadMateri();
  renderMateri();
  renderMaterialsTable();
  displayMaterialInfo();
  updateQuizScheduleInfo();
}

function logoutAdminPage() {
  document.getElementById('admin-dashboard').classList.add('hidden');
  document.getElementById('admin-access').classList.remove('hidden');
  document.getElementById('admin-page-login-form').reset();
}

function formatQuizDate(date) {
  return new Intl.DateTimeFormat('id-ID', { dateStyle: 'full' }).format(new Date(`${date}T00:00:00`));
}

function getTodayDate() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

function renderQuizScheduleList(schedules) {
  const scheduleDetails = document.querySelector('.schedule-details');
  if (!scheduleDetails) return;
  const mapelList = [...new Set(allMateri.map(material => material.mapel))];
  const displayedMapel = mapelList.length ? mapelList : ['KJR'];
  scheduleDetails.innerHTML = displayedMapel.map(mapel => {
    const schedule = schedules.find(item => item.mapel === mapel);
    return `<div><span>Mata pelajaran</span><strong>${getQuizMapelName(mapel)}</strong><span>Hari pelaksanaan</span><strong>${schedule ? formatQuizDate(schedule.date) : 'Belum ditentukan'}</strong></div>`;
  }).join('');
  scheduleDetails.classList.remove('hidden');
}

function updateQuizScheduleInfo() {
  const schedules = getQuizSchedules();
  const activeSchedule = getActiveQuizSchedule();
  const date = activeSchedule?.date || '';
  const info = document.getElementById('quiz-schedule-info');
  const detail = document.getElementById('quiz-date-detail');
  const mapelDetail = document.getElementById('quiz-mapel-detail');
  const dayDetail = document.getElementById('quiz-day-detail');
  const status = document.getElementById('quiz-status');
  const button = document.getElementById('btn-start');
  const scheduleMessages = schedules.map(schedule => `Kuis ${getQuizMapelName(schedule.mapel)} dapat dikerjakan pada ${formatQuizDate(schedule.date)}.`);
  const scheduleMessage = scheduleMessages.length ? scheduleMessages.join(' ') : 'Kuis dapat dikerjakan kapan saja.';
  renderQuizScheduleList(schedules);
  if (info) info.textContent = scheduleMessage;
  if (detail) detail.textContent = schedules.length > 1 ? `${schedules.length} jadwal kuis tersedia.` : scheduleMessage;
  if (mapelDetail) mapelDetail.textContent = schedules.length ? getQuizMapelName(schedules[0].mapel) : 'Keamanan Jaringan';
  if (dayDetail) dayDetail.textContent = schedules.length ? formatQuizDate(schedules[0].date) : 'Belum ditentukan';
  if (status) {
    status.textContent = date === getTodayDate() ? 'Kuis berlangsung hari ini.' : scheduleMessage;
    status.classList.toggle('quiz-status-active', date === getTodayDate());
  }
  const adminStatus = document.getElementById('admin-quiz-status');
  if (adminStatus) adminStatus.textContent = scheduleMessage;
  const selectedMapel = document.getElementById('select-mapel')?.value;
  const selectedSchedule = selectedMapel ? getQuizScheduleForMapel(selectedMapel) : activeSchedule;
  if (button) {
    button.disabled = false;
    button.title = schedules.length && (!selectedSchedule || selectedSchedule.date !== getTodayDate())
      ? 'Kuis belum tersedia sesuai jadwal.'
      : '';
  }
}

function logoutAdmin() {
  document.getElementById('admin-panel')?.classList.add('hidden');
  document.body.classList.remove('admin-mode');
  document.getElementById('profile-button').classList.remove('admin-active');
  document.getElementById('profile-button').setAttribute('aria-label', 'Login admin');
  if (document.getElementById('material-editor')) closeMaterialEditor();
  renderMateri();
}

function loadKuis() {
  const mapel = document.getElementById('select-mapel').value;
  const schedules = getQuizSchedules();
  const quizSchedule = getQuizScheduleForMapel(mapel);
  if (schedules.length && (!quizSchedule || quizSchedule.date !== getTodayDate())) {
    const identityError = document.getElementById('identitas-error');
    identityError.textContent = quizSchedule
      ? `Kuis ${getQuizMapelName(mapel)} dikunci sampai ${formatQuizDate(quizSchedule.date)}.`
      : `Kuis ${getQuizMapelName(mapel)} belum memiliki jadwal pelaksanaan.`;
    identityError.className = 'identity-error';
    return;
  }
  const nama = document.getElementById('nama-siswa').value.trim();
  const kelas = document.getElementById('kelas-siswa').value;
  const identityError = document.getElementById('identitas-error');
  if (!nama || !kelas) {
    identityError.textContent = 'Isi nama siswa dan pilih kelas terlebih dahulu sebelum mengerjakan kuis.';
    identityError.className = 'identity-error';
    if (!nama) document.getElementById('nama-siswa').focus();
    else document.getElementById('kelas-siswa').focus();
    return;
  }
  identityError.className = 'identity-error hidden';
  document.getElementById('quiz-fields').classList.add('hidden');
  document.getElementById('quiz-intro').classList.add('hidden');
  document.getElementById('btn-start').classList.add('hidden');
  currentQuestion = 0;
  score = 0;
  selectedAnswers = [];
  currentKuisData = fallbackKuis[mapel];
  document.getElementById('kuis-container').classList.remove('hidden');
  document.getElementById('hasil-kuis').className = 'hidden';
  document.getElementById('btn-next').style.display = 'block';
  renderQuestion();
}

function renderQuestion() {
  const q = currentKuisData[currentQuestion];
  startQuestionTimer();
  document.getElementById('nomor-soal').textContent = `Soal ${currentQuestion + 1} / ${currentKuisData.length}`;
  document.getElementById('skor-soal').textContent = `Skor: ${score}`;
  document.getElementById('soal-box').textContent = q.soal;
  document.getElementById('opsi-box').innerHTML = q.opsi.map((o, idx) => `<label class="option"><input type="radio" name="jawaban" value="${idx}">${o}</label>`).join('');
  if (selectedAnswers[currentQuestion] !== undefined) {
    document.querySelector(`input[name="jawaban"][value="${selectedAnswers[currentQuestion]}"]`).checked = true;
  }
}

function startQuestionTimer() {
  clearInterval(timerId);
  remainingSeconds = DEFAULT_QUIZ_DURATION;
  updateTimerDisplay();
  timerId = setInterval(() => {
    remainingSeconds--;
    updateTimerDisplay();
    if (remainingSeconds <= 0) {
      clearInterval(timerId);
      saveSelectedAnswer();
      if (currentQuestion === currentKuisData.length - 1) finishQuiz();
      else {
        currentQuestion++;
        renderQuestion();
      }
    }
  }, 1000);
}

function updateTimerDisplay() {
  const timer = document.getElementById('timer-soal');
  timer.textContent = `Waktu: ${remainingSeconds} detik`;
  timer.classList.toggle('timer-warning', remainingSeconds <= 10);
}

function saveSelectedAnswer() {
  const selected = document.querySelector('input[name="jawaban"]:checked');
  if (selected) selectedAnswers[currentQuestion] = Number(selected.value);
}

function cancelQuiz() {
  clearInterval(timerId);
  currentQuestion = 0;
  score = 0;
  selectedAnswers = [];
  document.getElementById('kuis-container').classList.add('hidden');
  document.getElementById('quiz-fields').classList.remove('hidden');
  document.getElementById('quiz-intro').classList.remove('hidden');
  document.getElementById('btn-start').classList.remove('hidden');
  document.getElementById('identitas-error').className = 'identity-error hidden';
  document.getElementById('hasil-kuis').className = 'hidden';
  document.getElementById('nama-siswa').value = '';
  document.getElementById('kelas-siswa').value = '';
  document.getElementById('btn-next').style.display = 'block';
}

function nextQuestion() {
  saveSelectedAnswer();
  if (selectedAnswers[currentQuestion] === undefined) {
    return alert('Pilih salah satu jawaban terlebih dahulu.');
  }
  clearInterval(timerId);
  if (currentQuestion === currentKuisData.length - 1) {
    finishQuiz();
    return;
  }
  currentQuestion++;
  renderQuestion();
}

function finishQuiz() {
  clearInterval(timerId);
  score = currentKuisData.reduce((total, question, index) => total + (selectedAnswers[index] === Number(question.jawaban) ? 1 : 0), 0);
  const hasil = document.getElementById('hasil-kuis');
  hasil.className = 'success';
  hasil.textContent = `Kuis selesai. Skormu ${score} dari ${currentKuisData.length}!`;
  saveScoreToSheet();
  document.getElementById('btn-next').style.display = 'none';
  document.getElementById('soal-box').textContent = 'Kerja bagus, terus tingkatkan pemahamanmu.';
  document.getElementById('opsi-box').innerHTML = '';
}

async function saveScoreToSheet() {
  if (!GOOGLE_SHEETS_URL) return;
  const payload = {
    nama: document.getElementById('nama-siswa').value.trim() || 'Tanpa nama',
    kelas: document.getElementById('kelas-siswa').value,
    mapel: document.getElementById('select-mapel').value,
    skor: score,
    totalSoal: currentKuisData.length,
    waktu: new Date().toISOString()
  };
  const hasil = document.getElementById('hasil-kuis');
  hasil.textContent += ' Mengirim nilai...';
  try {
    await fetch(GOOGLE_SHEETS_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    hasil.textContent = hasil.textContent.replace(' Mengirim nilai...', '') + ' Nilai dikirim. Cek sheet untuk memastikan data masuk.';
  } catch (err) {
    hasil.textContent = hasil.textContent.replace(' Mengirim nilai...', '') + ' Nilai gagal dikirim.';
  }
}

document.getElementById('search-materi')?.addEventListener('input', renderMateri);
document.getElementById('filter-mapel')?.addEventListener('change', renderMateri);
document.getElementById('select-mapel')?.addEventListener('change', updateQuizScheduleInfo);
addUploadMapelSelect();
document.getElementById('file-materi')?.addEventListener('change', event => addLocalMaterials(event.target.files));
document.getElementById('admin-login-form')?.addEventListener('submit', loginAdmin);
document.getElementById('landing-image-file')?.addEventListener('change', event => {
  const file = event.target.files[0];
  if (file && !file.type.startsWith('image/')) {
    event.target.value = '';
    alert('File landing page harus berupa gambar.');
  }
});
addPkpjOptions();
const quizMapelParam = new URLSearchParams(window.location.search).get('mapel');
if (quizMapelParam === 'TJKDN' && document.getElementById('select-mapel')) {
  document.getElementById('select-mapel').value = quizMapelParam;
  updateQuizScheduleInfo();
}
restrictClassOptions();
updateMainNavigation();
async function initializeApp() {
  // Set initial connection status
  updateConnectionStatus('loading');
  updateSyncIndicator(false);
  
  // Load fallback data immediately
  updateQuizScheduleInfo();
  renderLandingContent();
  await loadMateri();

  const hasLocalData = Boolean(
    localStorage.getItem(MATERIALS_KEY) ||
    localStorage.getItem(LANDING_CONTENT_KEY) ||
    allMateri.length
  );

  if (hasLocalData) {
    updateConnectionStatus('connected');
  }
  
  // Load remote config in background (non-blocking)
  loadRemoteConfig().then(() => {
    updateQuizScheduleInfo();
    renderLandingContent();
    renderMateri();
  });
  
  // Refresh config setiap 10 detik
  setInterval(() => {
    loadRemoteConfig().then(() => {
      renderMateri();
    });
  }, 10000);
}

initializeApp();
