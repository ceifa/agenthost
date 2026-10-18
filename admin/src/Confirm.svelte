<script>
  // A destructive button that asks for a second click before it acts.
  let { label, confirm, onconfirm, disabled = false } = $props();
  let armed = $state(false);
  let timer;

  function click() {
    clearTimeout(timer);
    if (armed) {
      armed = false;
      onconfirm();
    } else {
      armed = true;
      timer = setTimeout(() => (armed = false), 4000);
    }
  }
</script>

<button class="danger" class:armed {disabled} onclick={click} onblur={() => (armed = false)}>{armed ? confirm : label}</button>
