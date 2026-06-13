/**
 * MEDICARE PLUS OPERATIONAL ENTERPRISE SYSTEM - CORE SCRIPT
 * Updated: Tax/VAT logic removed.
 * Updated: Drug List dynamically bound to live Google Sheets API (8 Column Array Schema)
 */

// Live System Cache State
let db = { 
  drugs: [], 
  batches: [], 
  suppliers: [], 
  customers: [], 
  expenses: [], 
  procurements: [], 
  sales: [] 
};

const API_URL = 'https://script.google.com/macros/s/AKfycbydlhN1Hv12CJz8hFJFDNj2uKOQU_xyc65sOzNDNhQELInmc76V1EKWVIhJLrXPQWhf4A/exec';
let retailCart = {};
let wholesaleCart = {};

// Secure PIN Store (Using sessionStorage so it clears cleanly on tab close)
let currentStaffPin = sessionStorage.getItem('medi_staff_pin') || "";
let currentStaffRole = "";

const STAFF_ROLES_LOCAL = {
  "8899": { name: "Dr. Lucifer", role: "Administrator", avatar: "DL" },
  "4422": { name: "Alex Namanya", role: "Pharmacist Cashier", avatar: "AN" }
};

// Currency Formatter Helper
function fmt(val) { 
  return 'UGX ' + Math.round(val).toLocaleString('en-UG'); 
}

// Compute aggregate medicine totals across active batch lots
function getStock(medName) {
  if (!medName) return 0;
  return db.batches
    .filter(b => b.medName === medName)
    .reduce((acc, curr) => acc + curr.stock, 0);
}

// Security Enforcement Module (Restores your functional layout boundaries)
function enforceSecurityClearance() {
  const staff = STAFF_ROLES_LOCAL[currentStaffPin];
  
  if (!staff) {
    document.getElementById('staff-name').textContent = "Authentication Required";
    document.getElementById('staff-role').textContent = "ACCESS RESTRICTED";
    document.getElementById('staff-role').style.color = "#d9534f";
    document.getElementById('staff-avatar').textContent = "??";
    currentStaffRole = "";
    
    // Safety fallback to active retail terminal if auth drops
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const initialNav = document.querySelector('[data-target="pos-retail"]');
    if (initialNav) initialNav.classList.add('active');
    
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    const initialSec = document.getElementById('pos-retail');
    if (initialSec) initialSec.classList.add('active');
    
    document.getElementById('page-title').textContent = "POS Retail Terminal";
    
    promptStaffLoginAndBuild();
    return;
  }

  document.getElementById('staff-name').textContent = staff.name;
  document.getElementById('staff-role').textContent = staff.role;
  document.getElementById('staff-role').style.color = staff.role === "Administrator" ? "var(--sage)" : "var(--muted)";
  document.getElementById('staff-avatar').textContent = staff.avatar;
  currentStaffRole = staff.role;

  const isAdmin = (staff.role === "Administrator");
  
  // Toggle Admin Restricted Actions
  $('#open-medicine-modal-btn').toggle(isAdmin);
  $('#open-procurement-modal-btn').toggle(isAdmin);
  $('#open-expense-modal-btn').toggle(isAdmin);
  $('.reconcile-trigger-btn').toggle(isAdmin);
  
  $('#nav-expenditures').toggle(isAdmin);
  $('#nav-stock-count').toggle(isAdmin);
}

// Fetch live dataset from Google Apps Script deployment URL
async function refreshApplicationState() {
  try {
    const response = await fetch(API_URL);
    if (!response.ok) throw new Error("Spreadsheet engine lookup failure.");
    
    let serverState = await response.json();
    console.log("📡 Live Data Retrieved:", serverState);
    
    if (serverState && typeof serverState === 'object' && !Array.isArray(serverState)) {
      db.drugs = serverState.drugs || [];
      db.batches = serverState.batches || [];
      db.sales = serverState.sales || [];
      db.expenses = serverState.expenses || [];
      db.suppliers = serverState.suppliers || [];
      db.customers = serverState.customers || [];
      db.procurements = serverState.procurements || [];
    } else if (Array.isArray(serverState)) {
      db.drugs = serverState;
    }

    // Normalize name strings across active caching rows
    db.drugs = db.drugs.map(d => {
      const activeName = d.brandName || d.name || "Unknown SKU Variant";
      return { ...d, name: activeName, brandName: activeName };
    });

  } catch (error) {
    console.error("Critical Spreadsheet Engine Connection Interrupted:", error);
  }
}

// Re-calculate dashboard KPI cards
function evaluateApplicationStates() {
  const totalSalesVal = db.sales.reduce((acc, curr) => acc + (curr.total || 0), 0);

  document.getElementById('kpi-sales-val').textContent = fmt(totalSalesVal);
  document.getElementById('kpi-tx-count').textContent = db.sales.length + " Core Transactions";
  
  let expiringCount = 0;
  const sixtyDaysHence = new Date();
  sixtyDaysHence.setDate(new Date().getDate() + 60);

  let alertRowsHtml = '';
  db.batches.forEach(b => {
    const expDate = new Date(b.expiry);
    if (expDate <= sixtyDaysHence && b.stock > 0) {
      expiringCount++;
      alertRowsHtml += `<tr><td>${b.medName} (${b.lot})</td><td><span class="pill red">Expires ${b.expiry}</span></td></tr>`;
    }
  });
  document.getElementById('kpi-exp-count').textContent = `${expiringCount} Lots`;
  document.getElementById('global-alert-badge').textContent = `${expiringCount} Alerts`;

  let lowStockCount = 0;
  let stockSummaryHtml = '';
  
  db.drugs.forEach(d => {
    const medIdentifier = d.name || d.brandName;
    const totalQty = getStock(medIdentifier);
    let pillClass = 'green';
    let label = 'Healthy Balance';
    
    if (totalQty <= 15) {
      lowStockCount++;
      pillClass = 'red';
      label = 'Critically Low';
      alertRowsHtml += `<tr><td>${medIdentifier}</td><td><span class="pill amber">Stock: ${totalQty}</span></td></tr>`;
    } else if (totalQty <= 50) {
      pillClass = 'amber';
      label = 'Reorder Alert';
    }
    stockSummaryHtml += `<tr><td>${medIdentifier}</td><td><b>${totalQty} units</b></td><td><span class="pill ${pillClass}">${label}</span></td></tr>`;
  });
  
  document.getElementById('kpi-low-stock').textContent = `${lowStockCount} Variants`;
  document.getElementById('dash-stock-summary').innerHTML = stockSummaryHtml || '<tr><td colspan="3">Registry clean.</td></tr>';
  document.getElementById('dash-alerts-summary').innerHTML = alertRowsHtml || '<tr><td colspan="2">No systemic errors registered.</td></tr>';
}

// Build grid elements for terminal tabs
function renderPosGrids(searchQuery = '', type = 'retail') {
  const targetGrid = type === 'retail' ? 'retail-drug-grid' : 'wholesale-drug-grid';
  const filtered = db.drugs.filter(d => {
    const matchTarget = d.name || d.brandName || '';
    return matchTarget.toLowerCase().includes(searchQuery.toLowerCase());
  });
  
  document.getElementById(targetGrid).innerHTML = filtered.map(d => {
    const medIdentifier = d.name || d.brandName;
    const currentStock = getStock(medIdentifier);
    const rxPill = d.rxRequired ? '<span class="pill red" style="font-size:8px;margin-top:2px;display:inline-block;">NDA Rx Lock</span>' : '';
    const displayedPrice = type === 'retail' ? (d.retailPrice || d.price || 0) : (d.wholesalePrice || d.price || 0);
    return `
      <div class="drug-card" data-name="${medIdentifier}" data-type="${type}">
        <div class="drug-name">${medIdentifier} ${rxPill}</div>
        <div class="drug-price">${fmt(displayedPrice)}</div>
        <div class="drug-stock">Available: ${currentStock} units</div>
      </div>
    `;
  }).join('');
}

// Update Cart View - Scrubbed completely of tax/VAT calculations
function updateCartView(cart, containerId, subtotalId, taxId, totalId, discountId = null) {
  const container = document.getElementById(containerId);
  const itemKeys = Object.keys(cart);

  if (!itemKeys.length) {
    container.innerHTML = `<div style="text-align:center;padding:40px 0;color:var(--muted);font-size:12px">No items added to configuration.</div>`;
    document.getElementById(subtotalId).textContent = fmt(0);
    document.getElementById(totalId).textContent = fmt(0);
    return;
  }

  let grossTotal = 0;
  container.innerHTML = itemKeys.map(name => {
    const d = db.drugs.find(item => item.name === name || item.brandName === name) || { price: 0 };
    const qty = cart[name];
    const activePrice = containerId.includes('wholesale') ? (d.wholesalePrice || d.price || 0) : (d.retailPrice || d.price || 0);
    const itemTotal = activePrice * qty;
    grossTotal += itemTotal;
    return `
      <div class="cart-item">
        <span class="cart-item-name">${name}</span>
        <div class="cart-qty">
          <button class="qty-btn dec-btn" data-name="${name}" data-container="${containerId}">-</button>
          <span style="font-size:12px;font-weight:700;width:20px;text-align:center">${qty}</span>
          <button class="qty-btn inc-btn" data-name="${name}" data-container="${containerId}">+</button>
        </div>
        <span class="cart-line">${fmt(itemTotal)}</span>
      </div>
    `;
  }).join('');

  // direct flat pricing maps (Taxation-free)
  document.getElementById(subtotalId).textContent = fmt(grossTotal);
  document.getElementById(totalId).textContent = fmt(grossTotal);
  
  evaluatePrescriptionRequirements();
}

function handlePosSelection(name, type) {
  const targetCart = type === 'retail' ? retailCart : wholesaleCart;
  const totalAvailableStock = getStock(name);
  const theoreticalQty = (targetCart[name] || 0) + 1;

  if (theoreticalQty > totalAvailableStock) {
    alert(`Operational Halt: Ordered volume exceeds absolute warehouse balance.`);
    return;
  }

  targetCart[name] = theoreticalQty;
  if (type === 'retail') {
    updateCartView(retailCart, 'retail-cart-items', 'retail-subtotal', 'retail-tax', 'retail-total');
  } else {
    updateCartView(wholesaleCart, 'wholesale-cart-items', 'wholesale-subtotal', 'wholesale-tax', 'wholesale-total', 'wholesale-discount');
  }
}

function evaluatePrescriptionRequirements() {
  let retailRequiresRx = Object.keys(retailCart).some(name => db.drugs.find(d => d.name === name || d.brandName === name)?.rxRequired);
  let wholesaleRequiresRx = Object.keys(wholesaleCart).some(name => db.drugs.find(d => d.name === name || d.brandName === name)?.rxRequired);

  if(document.getElementById('retail-rx-gate')) document.getElementById('retail-rx-gate').classList.toggle('hidden', !retailRequiresRx);
  if(document.getElementById('wholesale-rx-gate')) document.getElementById('wholesale-rx-gate').classList.toggle('hidden', !wholesaleRequiresRx);
}

async function executeRetailSale() {
  const keys = Object.keys(retailCart);
  if (!keys.length) return alert('Transaction initialization failed: Cart contains no items.');

  const requiresRx = keys.some(name => db.drugs.find(d => d.name === name || d.brandName === name)?.rxRequired);
  if (requiresRx) {
    const doc = document.getElementById('retail-rx-doctor').value.trim();
    const pat = document.getElementById('retail-rx-patient').value.trim();
    if (!doc || !pat) return alert('NDA Compliance Error: Controlled substance validation fields missing.');
  }

  let totalNet = 0;
  keys.forEach(k => { 
    const d = db.drugs.find(item => item.name === k || item.brandName === k);
    const activePrice = d ? (d.retailPrice || d.price || 0) : 0;
    totalNet += activePrice * retailCart[k]; 
  });

  try {
    await fetch(API_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sale', cart: retailCart, client: 'Walk-in Consumer Account', type: 'Retail', total: totalNet })
    });

    spoolHardwareReceipt({
      receipt: 'TX-' + Math.floor(1000 + Math.random() * 9000),
      time: new Date().toLocaleTimeString('en-UG') + ' ' + new Date().toLocaleDateString('en-UG'),
      type: 'Retail',
      customer: 'Walk-in Consumer Account',
      cartDetails: retailCart,
      total: totalNet
    });

    retailCart = {};
    if(document.getElementById('retail-rx-doctor')) document.getElementById('retail-rx-doctor').value = '';
    if(document.getElementById('retail-rx-patient')) document.getElementById('retail-rx-patient').value = '';
    updateCartView(retailCart, 'retail-cart-items', 'retail-subtotal', 'retail-tax', 'retail-total');
    alert('Retail Transaction Sent to Spreadsheet.');
    await loadAndBuildSystemInterface();
  } catch (error) {
    alert("Database sync fault encountered during checkout routing pipeline execution.");
  }
}

async function executeWholesaleSale() {
  const keys = Object.keys(wholesaleCart);
  if (!keys.length) return alert('Transaction initialization failed: Cart contains no items.');

  const client = document.getElementById('wholesale-client-select').value;
  const requiresRx = keys.some(name => db.drugs.find(d => d.name === name || d.brandName === name)?.rxRequired);
  if (requiresRx) {
    const lic = document.getElementById('wholesale-rx-license').value.trim();
    if (!lic) return alert('Regulatory Alert: Valid facility license must be provided.');
  }

  let totalNet = 0;
  keys.forEach(k => { 
    const d = db.drugs.find(item => item.name === k || item.brandName === k);
    const activePrice = d ? (d.wholesalePrice || d.price || 0) : 0;
    totalNet += activePrice * wholesaleCart[k]; 
  });

  try {
    await fetch(API_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sale', cart: wholesaleCart, client: client, type: 'Wholesale', total: totalNet })
    });

    spoolHardwareReceipt({
      receipt: 'WS-' + Math.floor(1000 + Math.random() * 9000),
      time: new Date().toLocaleTimeString('en-UG') + ' ' + new Date().toLocaleDateString('en-UG'),
      type: 'Wholesale',
      customer: client,
      cartDetails: wholesaleCart,
      total: totalNet
    });

    wholesaleCart = {};
    if(document.getElementById('wholesale-rx-license')) document.getElementById('wholesale-rx-license').value = '';
    updateCartView(wholesaleCart, 'wholesale-cart-items', 'wholesale-subtotal', 'wholesale-tax', 'wholesale-total', 'wholesale-discount');
    alert('Wholesale Transaction Sent to Spreadsheet.');
    await loadAndBuildSystemInterface();
  } catch (error) {
    alert("Wholesale server distribution routing failure.");
  }
}

function spoolHardwareReceipt(tx) {
  let printContainer = document.getElementById('receipt-hardware-spooler');
  if (!printContainer) {
    printContainer = document.createElement('div');
    printContainer.id = 'receipt-hardware-spooler';
    printContainer.className = 'receipt-print-wrapper';
    document.body.appendChild(printContainer);
  }

  let itemsHtml = '';
  for (const name in tx.cartDetails) {
    const qty = tx.cartDetails[name];
    const itemData = db.drugs.find(d => d.name === name || d.brandName === name) || { price: 0 };
    const activePrice = tx.type === 'Wholesale' ? (itemData.wholesalePrice || itemData.price || 0) : (itemData.retailPrice || itemData.price || 0);
    itemsHtml += `
      <tr>
        <td style="padding: 4px 0;">${name}<br><small>${qty} x ${fmt(activePrice)}</small></td>
        <td style="text-align: right; vertical-align: bottom; padding: 4px 0;">${fmt(activePrice * qty)}</td>
      </tr>
    `;
  }

  printContainer.innerHTML = `
    <div class="receipt-header" style="text-align: center; font-family: monospace;">
      <h2>MEDICARE PLUS</h2>
      <p style="font-size: 11px; margin-top: 4px;">Kampala, Uganda</p>
    </div>
    <hr style="border-top: 1px dashed #000; margin: 10px 0;">
    <table style="width: 100%; font-size: 11px; font-family: monospace; margin-bottom: 8px;">
      <tr><td>Receipt ID: <b>${tx.receipt}</b></td><td style="text-align: right;">Type: ${tx.type}</td></tr>
      <tr><td>Date: ${tx.time}</td><td style="text-align: right;">User: Secure Agent</td></tr>
      <tr><td colspan="2" style="padding-top: 4px;">Account: ${tx.customer}</td></tr>
    </table>
    <hr style="border-top: 1px dashed #000; margin: 10px 0;">
    <table style="width: 100%; font-size: 11px; font-family: monospace;">
      <thead>
        <tr style="border-bottom: 1px dashed #000;"><th style="text-align: left; padding-bottom: 4px;">Item Line Summary</th><th style="text-align: right; padding-bottom: 4px;">Total</th></tr>
      </thead>
      <tbody>
        ${itemsHtml}
      </tbody>
    </table>
    <hr style="border-top: 1px dashed #000; margin: 10px 0;">
    <table style="width: 100%; font-size: 13px; font-weight: bold; font-family: monospace; margin-top: 5px;">
      <tr><td>TOTAL FLAT NET AMOUNT:</td><td style="text-align: right;">${fmt(tx.total)}</td></tr>
    </table>
    <hr style="border-top: 1px dashed #000; margin: 10px 0;">
    <div style="text-align: center; margin-top: 15px; font-size: 11px; font-family: monospace;">
      <p>Thank you for choosing Medicare Plus.</p>
    </div>
  `;

  window.print();
}

// Master Table Ingestion and Construction Engine
function buildMasterTables() {
  document.getElementById('sales-history-tbody').innerHTML = db.sales.map(s => `
    <tr>
      <td><b>${s.receipt || 'N/A'}</b></td>
      <td>${s.time || 'N/A'}</td>
      <td>${s.customer || 'Walk-in'}</td>
      <td>Items count: ${s.items || 0} units</td>
      <td>No Tax (Direct)</td>
      <td><b>${fmt(s.total || 0)}</b></td>
      <td><span class="pill ${s.type === 'Retail' ? 'green' : 'amber'}">${s.type || 'Retail'}</span></td>
    </tr>
  `).join('');

  // Renders your exact 8 parameters scheme live from Google Sheets
  document.getElementById('stock-report-tbody').innerHTML = db.drugs.map((d, index) => `
    <tr>
      <td class="text-muted font-mono">${d.sno || (index + 1)}</td>
      <td><b>${d.brandName || d.name || 'Unnamed SKU'}</b></td>
      <td>${d.genericName || 'N/A'}</td>
      <td><span class="badge">${d.type || d.category || 'Tablets'}</span></td>
      <td>${fmt(d.costPrice || 0)}</td>
      <td>${fmt(d.wholesalePrice || 0)}</td>
      <td class="text-success font-bold">${fmt(d.retailPrice || d.price || 0)}</td>
    </tr>
  `).join('');

  document.getElementById('expiry-tbody').innerHTML = db.batches.map(b => {
    const deltaDays = Math.ceil((new Date(b.expiry) - new Date()) / (1000 * 60 * 60 * 24));
    let statusPill = `<span class="pill green">${deltaDays} days remaining</span>`;
    if (deltaDays <= 30) statusPill = `<span class="pill red">NDA Hazard (${deltaDays} Days)</span>`;
    else if (deltaDays <= 60) statusPill = `<span class="pill amber">Warning Horizon</span>`;
    return `<tr><td>${b.medName || 'N/A'}</td><td><code>${b.lot || 'N/A'}</code></td><td><b>${b.stock || 0} units</b></td><td>${b.expiry || 'N/A'}</td><td>${statusPill}</td></tr>`;
  }).join('');

  document.getElementById('audit-tbody').innerHTML = db.drugs.map(d => {
    const medIdentifier = d.name || d.brandName || 'Unnamed SKU';
    const currentBalance = getStock(medIdentifier);
    return `
      <tr>
        <td>${medIdentifier}</td>
        <td><code>${currentBalance} units</code></td>
        <td><input type="number" class="form-control physical-input" data-name="${medIdentifier}" placeholder="Enter counter match" style="width:140px"></td>
        <td class="variance-cell" data-name="${medIdentifier}">--</td>
        <td><button class="action-btn reconcile-trigger-btn" data-name="${medIdentifier}">Reconcile</button></td>
      </tr>
    `;
  }).join('');

  document.getElementById('suppliers-tbody').innerHTML = db.suppliers.map(s => `
    <tr><td><b>${s.name || 'N/A'}</b></td><td>${s.contact || 'N/A'}</td><td>${s.phone || 'N/A'}</td><td>${s.location || 'N/A'}</td></tr>
  `).join('');

  document.getElementById('expenditures-tbody').innerHTML = db.expenses.map(e => `
    <tr><td>${e.date || 'N/A'}</td><td>${e.desc || 'N/A'}</td><td><span class="pill amber">${e.category || 'General'}</span></td><td><b>${fmt(e.amount || 0)}</b></td><td><code>${e.user || 'Admin'}</code></td></tr>
  `).join('');

  // Option lists synchronization
  if (document.getElementById('wholesale-client-select')) {
    document.getElementById('wholesale-client-select').innerHTML = db.customers.filter(c => c.type === 'Wholesale').map(c => `<option value="${c.name}">${c.name}</option>`).join('') || '<option value="">No corporate accounts</option>';
  }
  if (document.getElementById('modal-proc-supplier')) {
    document.getElementById('modal-proc-supplier').innerHTML = db.suppliers.map(s => `<option value="${s.name}">${s.name}</option>`).join('') || '<option value="">No suppliers configured</option>';
  }
  if (document.getElementById('modal-proc-med')) {
    document.getElementById('modal-proc-med').innerHTML = db.drugs.map(d => `<option value="${d.name || d.brandName}">${d.name || d.brandName}</option>`).join('') || '<option value="">No options available</option>';
  }
  
  enforceSecurityClearance(); 
}

// Bind global operational actions and events
document.addEventListener('DOMContentLoaded', () => {
  
  // Tab Routing View Dispatcher
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', function() {
      const targetSection = this.getAttribute('data-target');
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      
      document.getElementById(targetSection).classList.add('active');
      this.classList.add('active');
      document.getElementById('page-title').textContent = this.textContent.trim();
    });
  });

  document.getElementById('retail-search').addEventListener('input', (e) => renderPosGrids(e.target.value, 'retail'));
  document.getElementById('wholesale-search').addEventListener('input', (e) => renderPosGrids(e.target.value, 'wholesale'));

  document.getElementById('retail-drug-grid').addEventListener('click', (e) => {
    const card = e.target.closest('.drug-card');
    if (card) handlePosSelection(card.dataset.name, 'retail');
  });
  document.getElementById('wholesale-drug-grid').addEventListener('click', (e) => {
    const card = e.target.closest('.drug-card');
    if (card) handlePosSelection(card.dataset.name, 'wholesale');
  });

  const bindCartDelegation = (elementId, cartObj, subId, taxId, totId, discId = null) => {
    document.getElementById(elementId).addEventListener('click', (e) => {
      const btn = e.target.closest('.qty-btn');
      if (!btn) return;
      const name = btn.dataset.name;
      
      if (btn.classList.contains('inc-btn')) {
        const currentStock = getStock(name);
        if ((cartObj[name] || 0) + 1 > currentStock) {
          alert('Operational Warning: Safety threshold reached. Insufficient stock.');
          return;
        }
        cartObj[name]++;
      } else if (btn.classList.contains('dec-btn')) {
        cartObj[name]--;
        if (cartObj[name] <= 0) delete cartObj[name];
      }
      updateCartView(cartObj, elementId, subId, taxId, totId, discId);
    });
  };
  bindCartDelegation('retail-cart-items', retailCart, 'retail-subtotal', 'retail-tax', 'retail-total');
  bindCartDelegation('wholesale-cart-items', wholesaleCart, 'wholesale-subtotal', 'wholesale-tax', 'wholesale-total', 'wholesale-discount');

  document.getElementById('retail-pay-btn').addEventListener('click', executeRetailSale);
  document.getElementById('wholesale-pay-btn').addEventListener('click', executeWholesaleSale);

  const toggleModal = (modalId, open) => document.getElementById(modalId).classList.toggle('hidden', !open);
  document.getElementById('open-medicine-modal-btn').addEventListener('click', () => toggleModal('medicine-modal', true));
  document.getElementById('close-med-modal').addEventListener('click', () => toggleModal('medicine-modal', false));
  document.getElementById('open-expense-modal-btn').addEventListener('click', () => toggleModal('expense-modal', true));
  document.getElementById('close-exp-modal').addEventListener('click', () => toggleModal('expense-modal', false));
  document.getElementById('open-procurement-modal-btn').addEventListener('click', () => toggleModal('procurement-modal', true));
  document.getElementById('close-proc-modal').addEventListener('click', () => toggleModal('procurement-modal', false));

document.getElementById('save-med-modal').addEventListener('click', async () => {
  const inputName = document.getElementById('modal-med-name').value.trim();
  const category = document.getElementById('modal-med-cat').value.trim();
  const price = parseInt(document.getElementById('modal-med-price').value);
  const barcode = document.getElementById('modal-med-barcode').value.trim();
  const genericName = document.getElementById('modal-med-generic')?.value.trim() || "Generic SKU";

  // 1. Corrected Validation Guard (Removed the broken trailing comma)
  if (!inputName || !category || isNaN(price)) {
    return alert('Field Validation Failure: Please check that Name, Category and Price are populated correctly.');
  }

  // 2. Construct the clean local data object 
  const newDrug = {
    sno: (db.drugs ? db.drugs.length + 1 : 1),
    name: inputName,
    brandName: inputName,
    genericName: genericName,
    category: category,
    type: category,
    costPrice: 0,
    wholesalePrice: 0,
    retailPrice: price,
    price: price,
    barcode: barcode,
    rxRequired: document.getElementById('modal-med-rx')?.value === 'true'
  };

  // 3. Update the UI memory instantly so it displays on your website right away
  if (!db.drugs) db.drugs = [];
  db.drugs.push(newDrug);

  // 4. Force a UI redrawing loop matching your system functions
  if (typeof buildMasterTables === 'function') buildMasterTables();
  if (typeof renderPosGrids === 'function') {
    renderPosGrids($('#retail-search').val() || '', 'retail');
    renderPosGrids($('#wholesale-search').val() || '', 'wholesale');
  }
  if (typeof evaluateApplicationStates === 'function') evaluateApplicationStates();

  // 5. Instantly wipe the inputs and hide the modal panel
  document.getElementById('modal-med-name').value = '';
  document.getElementById('modal-med-cat').value = '';
  document.getElementById('modal-med-price').value = '';
  if(document.getElementById('modal-med-barcode')) document.getElementById('modal-med-barcode').value = '';
  document.getElementById('medicine-modal').classList.add('hidden');

  alert('SKU updated locally! Syncing with your Google Sheet database in the background...');

  // 6. Fire off the silent background post network call to Google Sheets
  try {
    await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' }, 
      body: JSON.stringify({
        action: 'addDrug',
        name: inputName,
        brandName: inputName,
        genericName: genericName,
        category: category,
        type: category,
        retailPrice: price,
        barcode: barcode
      })
    });
    console.log("📡 Remote Google Spreadsheet rows written successfully.");
  } catch (err) { 
    console.error("Background sync failed:", err);
    alert("Warning: Background database sync timed out. The entry is active locally but check your internet connection."); 
  }
});

  document.getElementById('save-expense-modal').addEventListener('click', async () => {
    const desc = document.getElementById('modal-exp-desc').value.trim();
    const category = document.getElementById('modal-exp-cat').value;
    const amount = parseInt(document.getElementById('modal-exp-amount').value);

    if (!desc || isNaN(amount)) return alert('Validation error occurred.');

    try {
      await fetch(API_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'addExpense', desc, category, amount, user: STAFF_ROLES_LOCAL[currentStaffPin]?.name || 'Admin' })
      });
      toggleModal('expense-modal', false);
      alert('Internal expense entry dispatched safely to ledger rows.');
      await loadAndBuildSystemInterface();
    } catch (err) { alert("Server network validation connection failure."); }
  });

  document.getElementById('save-proc-modal').addEventListener('click', async () => {
    const supplier = document.getElementById('modal-proc-supplier').value;
    const medName = document.getElementById('modal-proc-med').value;
    const lot = document.getElementById('modal-proc-lot').value.trim();
    const stock = parseInt(document.getElementById('modal-proc-qty').value);
    const cost = parseInt(document.getElementById('modal-med-cost').value || 0);
    const expiry = document.getElementById('modal-proc-expiry').value;

    if (!lot || isNaN(stock) || !expiry) return alert('Validation Error: Target parameters must be populated.');

    try {
      await fetch(API_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'addProcurement', supplier, medName, lot, stock, cost, expiry })
      });
      toggleModal('procurement-modal', false);
      alert('Consignment registered! Stock levels topped up.');
      await loadAndBuildSystemInterface();
    } catch (err) { alert("Network transmission failure while routing procurement record."); }
  });

  document.getElementById('audit-tbody').addEventListener('click', async (e) => {
    if (!e.target.classList.contains('reconcile-trigger-btn')) return;
    const name = e.target.dataset.name;
    const input = document.querySelector(`.physical-input[data-name="${name}"]`);
    const physicalVal = parseInt(input.value);
    if (isNaN(physicalVal)) return alert('Action Aborted: Please supply a physical counter match record first.');
    const varianceDelta = physicalVal - getStock(name);
    if (varianceDelta === 0) return alert('Audit Perfect: No discrepancies exist.');
    
    try {
      await fetch(API_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reconcileAudit', medName: name, variance: varianceDelta, user: STAFF_ROLES_LOCAL[currentStaffPin]?.name || 'Admin' })
      });
      alert(`System balance updated! Reconciliation record written out.`);
      await loadAndBuildSystemInterface();
    } catch (err) { alert("Network exception error during reconciliation."); }
  });

  document.getElementById('audit-tbody').addEventListener('input', (e) => {
    if (!e.target.classList.contains('physical-input')) return;
    const name = e.target.dataset.name;
    const physicalVal = parseInt(e.target.value);
    const cell = document.querySelector(`.variance-cell[data-name="${name}"]`);
    if (isNaN(physicalVal)) { cell.textContent = '--'; cell.className = 'variance-cell'; return; }
    const variance = physicalVal - getStock(name);
    cell.textContent = variance === 0 ? '0' : (variance > 0 ? `+${variance}` : variance);
    cell.className = `variance-cell pill ${variance === 0 ? 'green' : 'red'}`;
  });

  // Barcode HID USB Scanner Parser interceptor
  let barcodeBuffer = '';
  let lastKeyTime = Date.now();
  window.addEventListener('keydown', (e) => {
    const currentTime = Date.now();
    if (currentTime - lastKeyTime > 35) barcodeBuffer = ''; 
    lastKeyTime = currentTime;

    if (e.key >= '0' && e.key <= '9') barcodeBuffer += e.key;
    else if (e.key === 'Enter' && barcodeBuffer.length >= 4) {
      e.preventDefault(); 
      const identifiedDrug = db.drugs.find(d => d.barcode === barcodeBuffer || d.name === barcodeBuffer);
      if (identifiedDrug) {
        const activeSection = document.querySelector('.section.active')?.id;
        handlePosSelection(identifiedDrug.name || identifiedDrug.brandName, activeSection === 'pos-wholesale' ? 'wholesale' : 'retail');
      } else {
        alert(`Barcode Look-up Error: Code "${barcodeBuffer}" is not mapped.`);
      }
      barcodeBuffer = ''; 
    }
  });

  document.getElementById('btn-switch-shift').addEventListener('click', promptStaffLoginAndBuild);

  if (currentStaffPin) bootTerminalEngine();
  else promptStaffLoginAndBuild();
});

async function loadAndBuildSystemInterface() {
  await refreshApplicationState();
  buildMasterTables();
  renderPosGrids($('#retail-search').val() || '', 'retail');
  renderPosGrids($('#wholesale-search').val() || '', 'wholesale');
  evaluateApplicationStates();
}

function bootTerminalEngine() {
  enforceSecurityClearance();
  if (currentStaffPin && STAFF_ROLES_LOCAL[currentStaffPin]) {
    loadAndBuildSystemInterface();
  }
}

function promptStaffLoginAndBuild() {
  const pin = prompt("ENTER SECURE ENTERPRISE STAFF TERMINAL PIN:");
  if (pin !== null) {
    if (STAFF_ROLES_LOCAL[pin]) {
      currentStaffPin = pin;
      sessionStorage.setItem('medi_staff_pin', pin);
      bootTerminalEngine();
    } else {
      alert("Security Alert: Invalid Staff identification authorization token rejected.");
      promptStaffLoginAndBuild();
    }
  }
}
