(() => {
  "use strict";

  const root = document.documentElement;
  const story = document.querySelector("[data-story]");
  const scene = document.querySelector("[data-scene]");
  const opening = document.querySelector("[data-opening]");
  const mark = document.querySelector("[data-mark]");
  const wordmark = document.querySelector("[data-wordmark]");
  const panel = document.querySelector("[data-panel]");
  const productCopy = document.querySelector("[data-product-copy]");
  const appVisual = document.querySelector("[data-app-visual]");
  const proofs = [...document.querySelectorAll("[data-proof]")];
  const ambientImage = document.querySelector(".ambient img");
  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const desktopQuery = window.matchMedia("(min-width: 769px)");

  let sceneContext = null;
  let resizeObserver = null;

  function clearScene() {
    if (sceneContext) {
      sceneContext.revert();
      sceneContext = null;
    }

    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }

    window.ScrollTrigger?.getAll().forEach((trigger) => trigger.kill());
    root.classList.remove("motion-ok");
  }

  function buildScene() {
    clearScene();

    if (
      motionQuery.matches ||
      !desktopQuery.matches ||
      !window.gsap ||
      !window.ScrollTrigger ||
      !story ||
      !scene ||
      !opening ||
      !mark ||
      !wordmark ||
      !panel ||
      !productCopy ||
      !appVisual ||
      !ambientImage
    ) {
      return;
    }

    root.classList.add("motion-ok");
    window.gsap.registerPlugin(window.ScrollTrigger);

    sceneContext = window.gsap.context(() => {
      window.gsap.set(panel, {
        autoAlpha: 0,
        scale: 0.34,
        y: "30vh",
        transformOrigin: "50% 72%",
      });
      window.gsap.set(productCopy, { autoAlpha: 0, y: 28, scale: 0.98 });
      window.gsap.set(appVisual, { autoAlpha: 0, y: 30, scale: 0.96 });
      window.gsap.set(proofs, { autoAlpha: 0, y: 50, scale: 0.94 });

      const timeline = window.gsap.timeline({
        defaults: { ease: "power3.inOut" },
        scrollTrigger: {
          trigger: story,
          start: "top top",
          end: () => `+=${window.innerHeight * 5}`,
          pin: scene,
          pinSpacing: true,
          scrub: 1,
          anticipatePin: 1,
          invalidateOnRefresh: true,
        },
      });

      timeline
        .to(
          ambientImage,
          {
            scale: 1,
            opacity: 0.48,
            duration: 0.16,
            ease: "sine.inOut",
          },
          0
        )
        .to(
          mark,
          {
            x: "4vw",
            y: "-8vh",
            scale: 0.78,
            rotation: 1.5,
            duration: 0.1,
            ease: "power2.inOut",
          },
          0.08
        )
        .to(
          wordmark,
          {
            y: "-3vh",
            scale: 0.92,
            opacity: 0.56,
            duration: 0.1,
            ease: "power2.inOut",
          },
          0.08
        )
        .to(
          mark,
          {
            x: "14vw",
            y: "-30vh",
            scale: 0.08,
            rotation: 4,
            opacity: 0,
            duration: 0.14,
            ease: "power2.in",
          },
          0.18
        )
        .to(
          wordmark,
          {
            y: "-13vh",
            scale: 0.72,
            opacity: 0,
            duration: 0.1,
            ease: "power2.in",
          },
          0.18
        )
        .to(
          opening,
          {
            autoAlpha: 0,
            duration: 0.03,
          },
          0.29
        )
        .to(
          panel,
          {
            autoAlpha: 1,
            scale: 0.58,
            y: "10vh",
            duration: 0.14,
            ease: "power3.out",
          },
          0.2
        )
        .to(
          panel,
          {
            scale: 1,
            y: 0,
            duration: 0.18,
            ease: "power3.out",
          },
          0.34
        )
        .to(
          productCopy,
          {
            autoAlpha: 1,
            y: 0,
            scale: 1,
            duration: 0.1,
            ease: "power3.out",
          },
          0.47
        )
        .to(
          appVisual,
          {
            autoAlpha: 1,
            y: 0,
            scale: 1,
            duration: 0.11,
            ease: "power3.out",
          },
          0.5
        );

      proofs.forEach((proof, index) => {
        timeline.to(
          proof,
          {
            autoAlpha: 1,
            y: 0,
            scale: 1,
            duration: 0.065,
            ease: "power3.out",
          },
          0.62 + index * 0.075
        );
      });

      timeline.to({}, { duration: 0.09 }, 0.91);
    }, story);

    resizeObserver = new ResizeObserver(() => {
      window.ScrollTrigger.refresh();
    });
    resizeObserver.observe(scene);
  }

  function handlePreferenceChange() {
    buildScene();
  }

  motionQuery.addEventListener("change", handlePreferenceChange);
  desktopQuery.addEventListener("change", handlePreferenceChange);

  window.addEventListener(
    "load",
    () => {
      buildScene();
    },
    { once: true }
  );

  window.addEventListener("pagehide", clearScene, { once: true });
})();
