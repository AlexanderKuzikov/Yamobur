(function () {
  var btn = document.querySelector(".nav-toggle");
  var nav = document.querySelector(".main-nav");
  if (!btn || !nav) return;
  btn.addEventListener("click", function () {
    nav.classList.toggle("open");
  });
})();
