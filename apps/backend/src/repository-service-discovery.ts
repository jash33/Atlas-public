import { z } from 'zod';
import { repositoryServiceSchema, type RepositorySnapshot } from './github-repository-source.js';

export const serviceEvidenceSchema = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    quote: z.string().min(1).max(400),
  })
  .strict();
export const serviceDiscoverySchema = z
  .object({
    services: z
      .array(
        repositoryServiceSchema.extend({
          evidence: z.array(serviceEvidenceSchema).min(1).max(6),
        }),
      )
      .min(1)
      .max(20),
  })
  .strict();

export async function validateDiscoveredServices(
  input: unknown,
  snapshot: RepositorySnapshot,
  wasRead: (reference: z.infer<typeof serviceEvidenceSchema>) => boolean = () => true,
) {
  const { services } = serviceDiscoverySchema.parse(input);
  if (new Set(services.map((service) => service.serviceId)).size !== services.length)
    throw new Error('Discovered service names must be unique');
  for (const service of services) {
    const inside = (path: string) => service.root === '.' || path.startsWith(`${service.root}/`);
    if (!snapshot.files.some((file) => inside(file.path) && /\.[cm]?[jt]sx?$/.test(file.path)))
      throw new Error(`No application source found in discovered directory: ${service.root}`);
    if (!service.evidence.some((entry) => inside(entry.path) && /\.[cm]?[jt]sx?$/.test(entry.path)))
      throw new Error(
        `Service ${service.serviceId} needs application code evidence within its directory`,
      );
    for (const reference of service.evidence) {
      if (
        !snapshot.files.some((file) => file.path === reference.path) ||
        reference.endLine < reference.startLine ||
        !wasRead(reference)
      )
        throw new Error('Read the supporting code before identifying its service');
      const lines = (await snapshot.readFile(reference.path)).split('\n');
      if (
        reference.endLine > lines.length ||
        !lines
          .slice(reference.startLine - 1, reference.endLine)
          .join('\n')
          .includes(reference.quote)
      )
        throw new Error(`Service evidence does not match ${reference.path}:${reference.startLine}`);
    }
  }
  return services;
}
