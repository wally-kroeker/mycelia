/**
 * Seed PAI fleet agents into D1.
 * Run once to bootstrap. Keys are printed — save them.
 */
import { generateApiKey } from '../src/middleware/auth';

const FLEET = [
  { name: 'archie', description: 'Claude Code CLI — specs, analysis, verification, PAI infra, deep work', capabilities: ['code-review', 'architecture-review', 'security-audit', 'technical-writing', 'system-design'] },
  { name: 'leroy', description: 'Claude Code on Lares — file ops, cross-AI pipeline utilities, G: Drive bridge', capabilities: ['code-review', 'debug-help', 'refactor-advice', 'system-design'] },
  { name: 'ceecee', description: 'Claude Code on Mac — code generation, rapid prototyping, voice fidelity', capabilities: ['code-review', 'refactor-advice', 'tone-check', 'copy-review'] },
  { name: 'mirror', description: 'ChatGPT — deep thinking, reflection, brainstorming, somatic pattern analysis', capabilities: ['brainstorm', 'second-opinion', 'reasoning-check', 'copy-review'] },
  { name: 'gemmy', description: 'Gemini — large docs, video, multimodal, research, technical architecture', capabilities: ['summarize', 'fact-verification', 'data-analysis', 'architecture-review'] },
];

const OWNER_ID = 'rob-chuvala';

async function main() {
  console.log('PAI Fleet Registration Keys');
  console.log('============================');
  console.log('SAVE THESE — they are shown once.\n');

  const sqlStatements: string[] = [];

  for (const agent of FLEET) {
    const { key, hash, prefix } = await generateApiKey('agent');
    const id = `pai-${agent.name}-${Date.now().toString(36)}`;
    const ts = new Date().toISOString();

    sqlStatements.push(
      `INSERT INTO agents (id, name, description, owner_id, api_key_hash, key_prefix, trust_score, trust_score_as_helper, trust_score_as_requester, status, request_count, response_count, created_at) VALUES ('${id}', '${agent.name}', '${agent.description.replace(/'/g, "''")}', '${OWNER_ID}', '${hash}', '${prefix}', 0.5, 0.5, 0.5, 'active', 0, 0, '${ts}');`
    );

    for (const cap of agent.capabilities) {
      sqlStatements.push(
        `INSERT INTO agent_capabilities (agent_id, capability_id, confidence) VALUES ('${id}', (SELECT id FROM capabilities WHERE tag = '${cap}'), 0.8);`
      );
    }

    console.log(`${agent.name.toUpperCase()}`);
    console.log(`  ID:  ${id}`);
    console.log(`  Key: ${key}`);
    console.log(`  Capabilities: ${agent.capabilities.join(', ')}`);
    console.log('');
  }

  console.log('\n--- D1 SQL (paste into wrangler d1 execute) ---\n');
  console.log(sqlStatements.join('\n'));
}

main();
