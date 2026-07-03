/**
 * ViewStage — 简易 Markdown 渲染器
 * 用于在 OOBE / 设置中渲染 GitHub Releases 的更新日志
 */
function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderInline(text) {
  let result = escapeHtml(text);
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/`(.+?)`/g, '<code>$1</code>');
  result = result.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return result;
}

function renderMarkdownSimple(md) {
  if (!md) return '<p class="changelog-empty">暂无更新说明</p>';
  let html = '';
  const lines = md.split('\n');
  let in_list = false;
  let list_type = '';

  for (let raw of lines) {
    const line = raw.trimEnd();
    if (!line) {
      if (in_list) { html += list_type === 'ul' ? '</ul>\n' : '</ol>\n'; in_list = false; list_type = ''; }
      continue;
    }

    const header_match = line.match(/^(#{1,3})\s+(.+)/);
    if (header_match) {
      if (in_list) { html += list_type === 'ul' ? '</ul>\n' : '</ol>\n'; in_list = false; list_type = ''; }
      const level = header_match[1].length;
      const text = header_match[2];
      const tag = level <= 2 ? 'h3' : 'h4';
      html += `<${tag}>${renderInline(text)}</${tag}>\n`;
      continue;
    }

    const ul_match = line.match(/^[-*]\s+(.+)/);
    if (ul_match) {
      if (!in_list || list_type !== 'ul') {
        if (in_list) html += '</ul>\n';
        html += '<ul>\n';
        in_list = true;
        list_type = 'ul';
      }
      html += `<li>${renderInline(ul_match[1])}</li>\n`;
      continue;
    }

    const ol_match = line.match(/^\d+[.)]\s+(.+)/);
    if (ol_match) {
      if (!in_list || list_type !== 'ol') {
        if (in_list) html += '</ol>\n';
        html += '<ol>\n';
        in_list = true;
        list_type = 'ol';
      }
      html += `<li>${renderInline(ol_match[1])}</li>\n`;
      continue;
    }

    if (in_list) { html += list_type === 'ul' ? '</ul>\n' : '</ol>\n'; in_list = false; list_type = ''; }
    html += `<p>${renderInline(line)}</p>\n`;
  }

  if (in_list) html += list_type === 'ul' ? '</ul>\n' : '</ol>\n';
  return html;
}
