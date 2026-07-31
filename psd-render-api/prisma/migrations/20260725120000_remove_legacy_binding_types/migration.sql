-- 删除 group/pixel/adjustment 类型的绑定记录
-- 绑定类型已收紧为仅 smartObject 和 text
-- 注意：TemplateVersion.layerSchema 中的 JSON 字符串仍可能包含旧类型绑定，
--       由应用层 buildManifest 时过滤（仅保留 smartObject/text）。
DELETE FROM "LayerBinding" WHERE "type" IN ('group', 'pixel', 'adjustment');
