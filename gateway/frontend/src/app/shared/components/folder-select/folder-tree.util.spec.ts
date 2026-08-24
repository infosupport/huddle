import { ancestorPaths, buildFolderTree, folderRows, splitRoot } from './folder-tree.util';

// The picker rebuilds the folder hierarchy from flat paths, so this util decides
// what the tree in the portal looks like — including for Windows paths, which is
// the only notation most Huddle users will ever index.
describe('splitRoot', () => {
  it('neemt de driveletter als root', () => {
    expect(splitRoot('T:/projects/huddle')).toEqual({ root: 'T:/', rest: ['projects', 'huddle'] });
  });

  it('accepteert backslashes en kleine letters', () => {
    expect(splitRoot('t:\\projects\\huddle')).toEqual({ root: 'T:/', rest: ['projects', 'huddle'] });
  });

  it('houdt een UNC-share bij elkaar als root', () => {
    expect(splitRoot('//server/share/team/app')).toEqual({ root: '//server/share', rest: ['team', 'app'] });
  });

  it('gebruikt / als root op Linux-paden', () => {
    expect(splitRoot('/home/vscode/app')).toEqual({ root: '/', rest: ['home', 'vscode', 'app'] });
  });
});

describe('buildFolderTree', () => {
  it('zet vlakke paden om in een boom en markeert wat geïndexeerd is', () => {
    const tree = buildFolderTree(['T:/projects/huddle', 'T:/projects/huddle/gateway']);
    expect(tree.length).toBe(1);
    expect(tree[0].name).toBe('T:');
    // 'T:/projects' staat niet in de index maar bestaat aantoonbaar wel.
    const projects = tree[0].children[0];
    expect([projects.name, projects.indexed]).toEqual(['projects', false]);
    expect(projects.children[0].indexed).toBe(true);
    expect(projects.children[0].children[0].path).toBe('T:/projects/huddle/gateway');
  });

  it('voegt beide Windows-schrijfwijzen samen tot één tak', () => {
    const tree = buildFolderTree(['T:/projects/app', 't:\\projects\\app\\src']);
    expect(tree.length).toBe(1);
    expect(tree[0].children[0].children.length).toBe(1);
  });

  it('sorteert hoofdletterongevoelig', () => {
    const tree = buildFolderTree(['C:/a/Zebra', 'C:/a/apple', 'C:/a/Beta']);
    expect(tree[0].children[0].children.map((c) => c.name)).toEqual(['apple', 'Beta', 'Zebra']);
  });

  it('houdt meerdere drives uit elkaar', () => {
    expect(buildFolderTree(['C:/a', 'D:/b']).map((r) => r.name)).toEqual(['C:', 'D:']);
  });
});

describe('folderRows', () => {
  const tree = buildFolderTree(['T:/projects/huddle/gateway', 'T:/projects/other']);

  it('toont alleen wat opengeklapt is', () => {
    expect(folderRows(tree, new Set()).map((r) => r.node.name)).toEqual(['T:']);
    expect(folderRows(tree, new Set(['t:/'])).map((r) => r.node.name)).toEqual(['T:', 'projects']);
  });

  it('klapt bij filteren de tak met de treffer zelf open', () => {
    const names = folderRows(tree, new Set(), 'gateway').map((r) => r.node.name);
    expect(names).toEqual(['T:', 'projects', 'huddle', 'gateway']);
  });

  it('laat takken zonder treffer weg', () => {
    const paths = folderRows(tree, new Set(), 'other').map((r) => r.node.path);
    expect(paths).toEqual(['T:/', 'T:/projects', 'T:/projects/other']);
  });

  it('geeft de diepte mee voor de inspringing', () => {
    expect(folderRows(tree, new Set(), 'gateway').map((r) => r.depth)).toEqual([0, 1, 2, 3]);
  });
});

describe('ancestorPaths', () => {
  it('geeft de takken die open moeten om een waarde te tonen', () => {
    expect(ancestorPaths('T:/projects/huddle/gateway')).toEqual(['T:/', 'T:/projects', 'T:/projects/huddle']);
  });

  it('heeft voor een root niets open te klappen', () => {
    expect(ancestorPaths('T:/')).toEqual(['T:/']);
  });
});
