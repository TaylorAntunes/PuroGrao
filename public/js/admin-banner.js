function previewBanner() {
  const active = $('#banner-active').checked;
  $('#banner-title').required = active;
  $('#banner-preview-title').textContent = $('#banner-title').value.trim() || 'Título do seu destaque';
  $('#banner-preview-description').textContent = $('#banner-description').value;
  $('#banner-preview-link').textContent = $('#banner-link-label').value;
  $('#banner-preview-link').hidden = !$('#banner-link-label').value.trim() || !$('#banner-link-url').value.trim();
  $('#banner-preview-note').textContent = active ? 'O banner aparecerá na Home depois de salvar.' : 'O banner está desativado. A prévia não aparece na Home.';
  $('#banner-status').textContent = '';
}
async function loadBanner() {
  const session = captureAdminSession();
  const { banner } = await api('/banner');
  assertAdminSession(session);
  $('#banner-active').checked = banner.active;
  for (const key of ['title', 'description', 'link_label', 'link_url']) $(`#banner-${key.replace(/_/g, '-')}`).value = banner[key];
  previewBanner();
}
function clearBannerSession() {
  $('#banner-active').checked = false;
  for (const field of ['title', 'description', 'link-label', 'link-url']) $(`#banner-${field}`).value = '';
  previewBanner();
}
$('#banner-form').oninput = previewBanner;
$('#banner-form').onsubmit = async event => {
  event.preventDefault();
  const session = captureAdminSession();
  if (!adminSessionIsCurrent(session)) return;
  $('#banner-save').disabled = true;
  $('#banner-status').textContent = '';
  $('#aerr').textContent = '';
  try {
    await api('/banner', 'PUT', {
      active: $('#banner-active').checked, title: $('#banner-title').value,
      description: $('#banner-description').value, link_label: $('#banner-link-label').value, link_url: $('#banner-link-url').value,
    });
    assertAdminSession(session);
    $('#banner-status').textContent = $('#banner-active').checked ? 'Banner salvo e publicado na Home.' : 'Banner salvo e ocultado da Home.';
  } catch (error) { showError(error); }
  finally { if (adminSessionIsCurrent(session)) $('#banner-save').disabled = false; }
};

