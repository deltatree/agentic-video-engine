// Studio-Panel des Beispiel-Plugins. Läuft in einem sandboxed iframe; `ctx.project` ist das
// aktuelle Projekt (nur lesen), `ctx.onProject` meldet Änderungen, `ctx.notify` schreibt in die Statuszeile.
export default function mount(root, ctx) {
  const title = document.createElement('h3');
  title.textContent = 'Hello from a plugin';
  const list = document.createElement('ul');
  const button = document.createElement('button');
  button.textContent = 'Say hello';
  button.addEventListener('click', () => ctx.notify('Hello from the panel!'));
  root.append(title, list, button);
  ctx.onProject((project) => {
    list.replaceChildren(
      ...(project.compositions ?? []).map((c) => {
        const li = document.createElement('li');
        li.textContent = `${c.id}: ${c.width}×${c.height} @ ${c.fps} fps, ${(c.nodes ?? []).length} nodes`;
        return li;
      }),
    );
  });
}
