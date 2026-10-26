(async function () {
  const storageApi = chrome.storage.session || chrome.storage.local;
  const data = await storageApi.get('printHtml');
  const printHtml = data ? data.printHtml : null;

  if (!printHtml) {
    document.body.textContent = 'Nothing to print. Export again from WhatsApp Web.';
    return;
  }

  await storageApi.remove('printHtml');

  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0';
  document.body.replaceChildren(frame);
  frame.srcdoc = printHtml;

  frame.onload = () => {
    document.title = frame.contentDocument?.title || document.title;
    setTimeout(() => {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    }, 400);
  };
})();
