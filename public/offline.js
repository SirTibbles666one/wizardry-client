// The offline page has no app bundle to translate it; this table does, and
// returns to the app as soon as the connection does.
(function () {
  "use strict";
  var text = {
    en: ["You're offline", "Wizardry needs a connection to reach your chats. It will open as soon as you're back online.", "Try again"],
    de: ["Du bist offline", "Wizardry braucht eine Verbindung, um deine Chats zu erreichen. Sobald du wieder online bist, öffnet es sich.", "Erneut versuchen"],
    es: ["Estás sin conexión", "Wizardry necesita conexión para llegar a tus chats. Se abrirá en cuanto vuelvas a estar en línea.", "Reintentar"],
    fr: ["Vous êtes hors ligne", "Wizardry a besoin d'une connexion pour accéder à vos discussions. Il s'ouvrira dès votre retour en ligne.", "Réessayer"],
    it: ["Sei offline", "Wizardry ha bisogno di una connessione per raggiungere le tue chat. Si aprirà appena tornerai online.", "Riprova"],
    nl: ["Je bent offline", "Wizardry heeft een verbinding nodig om je chats te bereiken. Het opent zodra je weer online bent.", "Opnieuw proberen"],
    pt: ["Você está offline", "O Wizardry precisa de conexão para acessar suas conversas. Ele abre assim que você voltar a ficar online.", "Tentar novamente"],
    ja: ["オフラインです", "Wizardry でチャットを表示するにはインターネット接続が必要です。オンラインに戻るとすぐに開きます。", "再試行"],
  };
  var stored = null;
  try { stored = localStorage.getItem("armada:locale"); } catch (e) { /* storage blocked */ }
  var tag = String(stored || navigator.language || "en").toLowerCase();
  var lang = tag.slice(0, 2);
  var t = text[lang] || text.en;
  document.documentElement.lang = text[lang] ? (lang === "pt" ? "pt-BR" : lang) : "en";
  document.getElementById("title").textContent = t[0];
  document.getElementById("body").textContent = t[1];
  document.getElementById("retry").textContent = t[2];
  var target = location.pathname + location.search + location.hash;
  document.getElementById("retry").setAttribute("href", target);
  window.addEventListener("online", function () { location.reload(); });
})();
