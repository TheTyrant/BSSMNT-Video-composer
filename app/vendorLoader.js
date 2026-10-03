// Loads a library from vendor/ on first use, as a plain <script> (D-64).
// Plain scripts load from a local server AND from index.html opened
// straight from disk (file://), in every browser; module imports don't.
const VendorLoader = (() => {
  const pending = new Map();
  function load(file, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    if (!pending.has(file)) {
      pending.set(file, new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = `vendor/${file}`;
        s.onload = () => (window[globalName] ? resolve(window[globalName]) : reject(new Error(`${file} loaded but ${globalName} is missing`)));
        s.onerror = () => { pending.delete(file); reject(new Error(`Could not load vendor/${file}. Is the vendor folder next to index.html?`)); };
        document.head.appendChild(s);
      }));
    }
    return pending.get(file);
  }
  return {
    zip: () => load('fflate.js', 'fflate'),
    media: () => load('mediabunny.js', 'Mediabunny'),
  };
})();
