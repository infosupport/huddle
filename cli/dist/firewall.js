"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runFirewallList = runFirewallList;
const api_1 = require("./api");
const utils_1 = require("./utils");
async function runFirewallList(opts) {
    const qs = new URLSearchParams({ status: opts.status ?? 'requested' });
    if (opts.container)
        qs.set('container', opts.container);
    const rules = await (0, api_1.get)(`/api/rules?${qs}`);
    if (rules.length === 0) {
        console.log((0, utils_1.dim)('Geen openstaande firewall-verzoeken.'));
        return;
    }
    if (!opts.interactive) {
        printRulesTable(rules);
        return;
    }
    console.log(`${(0, utils_1.bold)(String(rules.length))} openstaand(e) verzoek(en). Beoordeel elk:\n`);
    for (let i = 0; i < rules.length; i++) {
        await reviewRule(rules[i], i + 1, rules.length);
        console.log();
    }
}
async function reviewRule(rule, idx, total) {
    const target = formatTarget(rule);
    const scope = rule.container_id ? `container: ${rule.container_id}` : 'globaal';
    const example = rule.last_path ? `, voorbeeld: ${rule.last_path}` : '';
    console.log(`[${idx}/${total}] ${(0, utils_1.bold)((0, utils_1.cyan)(target))}  ${(0, utils_1.dim)(`(${scope}, ${rule.request_count} req, ${(0, utils_1.formatTime)(rule.last_seen)}${example})`)}`);
    const key = await (0, utils_1.promptKey)(`  ${(0, utils_1.bold)('[a]')}llow  ${(0, utils_1.bold)('[d]')}eny  ${(0, utils_1.bold)('[A]')}llow globaal  ${(0, utils_1.bold)('[D]')}eny globaal  ${(0, utils_1.bold)('[s]')}kip > `);
    switch (key) {
        case 'a':
            await resolveRule(rule, 'allow', 'rule');
            console.log((0, utils_1.green)(`  [OK] Toegestaan voor ${rule.container_id ?? 'globaal'}`));
            break;
        case 'd':
            await resolveRule(rule, 'deny', 'rule');
            console.log((0, utils_1.red)(`  [OK] Geblokkeerd voor ${rule.container_id ?? 'globaal'}`));
            break;
        case 'A':
            await resolveRule(rule, 'allow', 'global');
            console.log((0, utils_1.green)(`  [OK] Globaal toegestaan: ${target}`));
            break;
        case 'D':
            await resolveRule(rule, 'deny', 'global');
            console.log((0, utils_1.red)(`  [OK] Globaal geblokkeerd: ${target}`));
            break;
        default:
            console.log((0, utils_1.dim)('  Overgeslagen'));
    }
}
async function resolveRule(rule, status, scope) {
    await (0, api_1.post)(`/api/rules/${rule.id}/resolve`, { status, scope });
}
function printRulesTable(rules) {
    const headers = ['ID', 'Status', 'Domein/pad', 'Container', 'Verzoeken', 'Gezien'];
    const rows = rules.map((r) => [
        String(r.id),
        r.status,
        formatTarget(r),
        r.container_id ?? '(globaal)',
        String(r.request_count),
        (0, utils_1.formatTime)(r.last_seen),
    ]);
    (0, utils_1.printTable)(headers, rows);
}
function formatTarget(rule) {
    return rule.path_pattern ? `${rule.domain}${rule.path_pattern}` : rule.domain;
}
