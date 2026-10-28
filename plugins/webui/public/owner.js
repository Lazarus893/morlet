(() => {
  const form = document.querySelector('#owner-login'), status = document.querySelector('#owner-status');
  const message = (text, error = false) => { status.textContent = text; status.dataset.error = String(error); };
  const password = form.elements.password;
  password.addEventListener('input', () => {
    if (password.hasAttribute('aria-invalid')) { password.removeAttribute('aria-invalid'); message(''); }
  });
  fetch('/api/owner', { cache: 'no-store' }).then(r => r.json()).then(value => {
    if (!value.secure) { form.hidden = true; message('请使用 HTTPS 地址，或在运行 Morlet 的电脑上通过 127.0.0.1 访问。', true); }
    else if (!value.configured) { form.hidden = true; document.querySelector('#owner-help').open = true; message('先在本机设置主人密码。'); }
  }).catch(() => message('暂时无法连接，请刷新重试。', true));
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = form.querySelector('button'), label = button.querySelector('span');
    button.disabled = true; form.setAttribute('aria-busy', 'true'); label.textContent = '正在打开…'; message('');
    try {
      const response = await fetch('/api/auth/sign-in/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@xiaoman.local', password: form.elements.password.value }) });
      if (response.ok) { location.reload(); return; }
      message(response.status === 429 ? '尝试次数较多，请一分钟后再试。' : '密码不正确，或登录暂时不可用。', true);
      if (response.status === 401) { password.setAttribute('aria-invalid', 'true'); password.focus(); }
    } catch { message('暂时无法连接，密码未提交成功。', true); }
    finally { button.disabled = false; form.removeAttribute('aria-busy'); label.textContent = '进入'; }
  });
})();
