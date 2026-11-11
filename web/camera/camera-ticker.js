// Cadence de la caméra du miroir. Les minuteries d'un onglet en arrière-plan sont ralenties
// à une par seconde (puis par minute) ; celles d'un worker dédié ne le sont pas.
let timer = null;
self.onmessage = ({ data }) => {
  clearInterval(timer);
  timer = typeof data === 'number' && data > 0 ? setInterval(() => self.postMessage(0), data) : null;
};
