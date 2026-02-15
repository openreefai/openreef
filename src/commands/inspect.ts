import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadManifest } from '../core/manifest-loader.js';
import { validateSchema } from '../core/schema-validator.js';
import { header, label, value, table, icons } from '../utils/output.js';

export async function inspect(path: string): Promise<void> {
  const formationDir = resolve(path);
  const manifest = await loadManifest(formationDir);

  // Quick schema check
  const schemaResult = await validateSchema(manifest);
  if (!schemaResult.valid) {
    console.log(
      `${icons.warning} Schema issues found — run ${chalk.bold('reef validate')} for details\n`,
    );
  }

  // Metadata header
  console.log(header('Formation'));
  console.log(
    table([
      [label('Name:'), value(manifest.name)],
      [label('Version:'), value(manifest.version)],
      [label('Type:'), value(manifest.type)],
      [label('Namespace:'), value(manifest.namespace)],
      [label('Description:'), manifest.description],
      ...(manifest.author
        ? [[label('Author:'), manifest.author]]
        : []),
      ...(manifest.license
        ? [[label('License:'), manifest.license]]
        : []),
    ]),
  );

  // Compatibility
  if (manifest.compatibility?.openclaw) {
    console.log(`\n${header('Compatibility')}`);
    console.log(`  OpenClaw ${value(manifest.compatibility.openclaw)}`);
  }

  // Agents table
  console.log(`\n${header('Agents')}`);
  const agentRows: string[][] = [
    [chalk.dim('Slug'), chalk.dim('Role'), chalk.dim('Model'), chalk.dim('Description')],
  ];
  for (const [slug, agent] of Object.entries(manifest.agents)) {
    agentRows.push([
      value(slug),
      agent.role ?? '-',
      agent.model ?? '-',
      agent.description,
    ]);
  }
  console.log(table(agentRows));

  // Variables table
  if (manifest.variables && Object.keys(manifest.variables).length > 0) {
    console.log(`\n${header('Variables')}`);
    const varRows: string[][] = [
      [chalk.dim('Name'), chalk.dim('Type'), chalk.dim('Required'), chalk.dim('Default'), chalk.dim('Description')],
    ];
    for (const [name, v] of Object.entries(manifest.variables)) {
      varRows.push([
        value(name),
        v.type,
        v.required ? 'yes' : 'no',
        v.sensitive ? chalk.dim('[sensitive]') : v.default !== undefined ? String(v.default) : '-',
        v.description ?? '-',
      ]);
    }
    console.log(table(varRows));
  }

  // Topology arrows
  if (manifest.agentToAgent && Object.keys(manifest.agentToAgent).length > 0) {
    console.log(`\n${header('Communication Topology')}`);
    for (const [source, targets] of Object.entries(manifest.agentToAgent)) {
      for (const target of targets) {
        console.log(`  ${value(source)} ${chalk.dim('\u2192')} ${value(target)}`);
      }
    }
  }

  // Bindings
  if (manifest.bindings && manifest.bindings.length > 0) {
    console.log(`\n${header('Bindings')}`);
    const bindingRows: string[][] = [
      [chalk.dim('Channel'), chalk.dim('Agent')],
    ];
    for (const b of manifest.bindings) {
      bindingRows.push([value(b.channel), value(b.agent)]);
    }
    console.log(table(bindingRows));
  }

  // Cron
  if (manifest.cron && manifest.cron.length > 0) {
    console.log(`\n${header('Cron Jobs')}`);
    const cronRows: string[][] = [
      [chalk.dim('Schedule'), chalk.dim('Agent'), chalk.dim('Prompt')],
    ];
    for (const job of manifest.cron) {
      const tz = job.timezone ? ` (${job.timezone})` : '';
      cronRows.push([
        value(job.schedule) + tz,
        value(job.agent),
        job.prompt.length > 60 ? job.prompt.slice(0, 57) + '...' : job.prompt,
      ]);
    }
    console.log(table(cronRows));
  }

  // Dependencies
  if (manifest.dependencies) {
    const skills = manifest.dependencies.skills;
    const services = manifest.dependencies.services;

    if (skills && Object.keys(skills).length > 0) {
      console.log(`\n${header('Skills')}`);
      for (const [name, version] of Object.entries(skills)) {
        console.log(`  ${value(name)} ${chalk.dim(version)}`);
      }
    }

    if (services && services.length > 0) {
      console.log(`\n${header('Services')}`);
      for (const svc of services) {
        const req = svc.required !== false ? chalk.red('required') : chalk.dim('optional');
        console.log(`  ${value(svc.name)} ${req}${svc.url ? chalk.dim(` (${svc.url})`) : ''}`);
      }
    }
  }
}
