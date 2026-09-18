export function style(element: HTMLElement, values: Partial<CSSStyleDeclaration>) { Object.assign(element.style, values); }

export function button(label: string, title = label) {
  const element = document.createElement('button'); element.type = 'button'; element.textContent = label; element.title = title;
  style(element, { border: '1px solid #3f3f46', borderRadius: '7px', background: '#27272a', color: '#fafafa', padding: '6px 9px', cursor: 'pointer', font: '12px system-ui, sans-serif' });
  return element;
}
