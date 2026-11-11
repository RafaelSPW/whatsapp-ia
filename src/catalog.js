const fs = require('fs');
const path = require('path');

const CATALOG_FILE = path.join(__dirname, '..', 'data', 'catalog.json');

function loadCatalog() {
  try {
    if (!fs.existsSync(CATALOG_FILE)) return [];
    return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveCatalog(items) {
  fs.mkdirSync(path.dirname(CATALOG_FILE), { recursive: true });
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(items, null, 2), 'utf8');
}

function formatCatalogForDisplay(items) {
  if (!items.length) return 'El catálogo está vacío.';
  return items
    .map((item, i) => `${i + 1}. *${item.nombre}*${item.precio ? ` — $${item.precio}` : ''}${item.descripcion ? `\n   ${item.descripcion}` : ''}`)
    .join('\n');
}

// Parse lines like: "Nombre | Precio | Descripcion"
function parseCatalogText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const items = [];
  for (const line of lines) {
    const parts = line.split('|').map(p => p.trim());
    if (parts.length >= 1 && parts[0]) {
      items.push({
        nombre: parts[0],
        precio: parts[1] || '',
        descripcion: parts[2] || '',
      });
    }
  }
  return items;
}

module.exports = { loadCatalog, saveCatalog, formatCatalogForDisplay, parseCatalogText };
