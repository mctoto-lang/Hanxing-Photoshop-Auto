export type TemplateDisplayStatus = '待发布' | '已发布' | '编辑后需重新发布';

export function getTemplateDisplayStatus(status: string, published: boolean): TemplateDisplayStatus {
  if (status === 'PUBLISHED' && published) return '已发布';
  if (status === 'DRAFT' && !published) return '待发布';
  return '编辑后需重新发布';
}

export function hasConfiguredBindings(layerSchema: string): boolean {
  try {
    const schema = JSON.parse(layerSchema) as { bindings?: unknown[] };
    return Array.isArray(schema.bindings) && schema.bindings.length > 0;
  } catch {
    return false;
  }
}
