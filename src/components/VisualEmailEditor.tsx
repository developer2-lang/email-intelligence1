import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import grapesjs, { type Editor } from 'grapesjs';
import 'grapesjs/dist/css/grapes.min.css';
import { uploadEmailImage } from '../services/campaignService';

const TOOLBAR_CSS = `
.te-editor .gjs-toolbar { display: flex !important; flex-direction: row !important; align-items: center !important; gap: 3px !important; padding: 5px 6px !important; border-radius: 10px !important; background: #1a2236 !important; box-shadow: 0 6px 20px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.08) !important; border: none !important; width: max-content !important; max-width: 100% !important; white-space: nowrap !important; z-index: 300 !important; }
.te-editor .gjs-toolbar-item { display: inline-flex !important; align-items: center !important; justify-content: center !important; flex-shrink: 0 !important; height: 34px !important; min-width: 34px !important; padding: 0 10px !important; font-size: 15px !important; font-weight: 700 !important; letter-spacing: 0 !important; color: #CBD5E1 !important; background: rgba(255,255,255,0.07) !important; border: 1px solid rgba(255,255,255,0.1) !important; border-radius: 6px !important; cursor: pointer !important; transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease !important; text-decoration: none !important; line-height: 1 !important; box-sizing: border-box !important; white-space: nowrap !important; overflow: visible !important; }
.te-editor .gjs-toolbar-item:hover { background: rgba(96, 165, 250, 0.2) !important; border-color: rgba(96, 165, 250, 0.5) !important; color: #F1F5F9 !important; }
.te-editor .gjs-toolbar-item:active { transform: scale(0.94) !important; }
.te-editor .gjs-toolbar-item#te-delete { width: 34px !important; min-width: 34px !important; padding: 0 !important; margin-left: 4px !important; color: #F87171 !important; background: rgba(248, 113, 113, 0.1) !important; border: 1px solid rgba(248, 113, 113, 0.25) !important; border-radius: 6px !important; position: relative !important; }
.te-editor .gjs-toolbar-item#te-delete::before { content: '' !important; position: absolute !important; left: -6px !important; top: 6px !important; bottom: 6px !important; width: 1px !important; background: rgba(255,255,255,0.15) !important; }
.te-editor .gjs-toolbar-item#te-delete:hover { background: rgba(248, 113, 113, 0.25) !important; border-color: rgba(248, 113, 113, 0.5) !important; color: #FCA5A5 !important; }
.te-editor .gjs-toolbar-item i, .te-editor .gjs-toolbar-item .fa, .te-editor .gjs-toolbar-item [class*="fa "], .te-editor .gjs-toolbar-item span, .te-editor .gjs-toolbar-item svg { font-size: 15px !important; font-weight: 400 !important; line-height: 1 !important; color: inherit !important; font-family: inherit !important; width: auto !important; height: auto !important; max-width: 20px !important; max-height: 20px !important; min-width: 16px !important; min-height: 16px !important; margin: 0 !important; padding: 0 !important; }
.te-editor .gjs-toolbar-item svg { width: 18px !important; height: 18px !important; }
.te-editor .gjs-toolbar > * { margin: 0 !important; padding: 0 !important; }
`;

export interface VisualEmailEditorHandle {
  /** Serialize the current canvas back to a full HTML document (doctype + head + body + embedded CSS). */
  getHtml: () => string;
}

export interface VisualEmailEditorProps {
  /** Full HTML document (or fragment) loaded into the editor. Read ONCE on mount — re-mount to reload. */
  initialHtml?: string;
  /** Fired (debounced) whenever the user changes the layout/content/styles. */
  onChange: (html: string) => void;
  /** Fired when an image upload fails so the caller can surface the error. */
  onError?: (message: string) => void;
}

const IMAGE_PLACEHOLDER = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="320"><rect width="100%" height="100%" fill="#EEF2F7"/><text x="50%" y="46%" fill="#94A3B8" font-family="Arial, sans-serif" font-size="20" text-anchor="middle">Double-click to add an image</text><text x="50%" y="62%" fill="#CBD5E1" font-family="Arial, sans-serif" font-size="14" text-anchor="middle">or select it and click Replace</text></svg>'
)}`;

const FONT_FAMILIES = [
  { value: 'Arial', name: 'Arial' },
  { value: 'Arial Black', name: 'Arial Black' },
  { value: 'Georgia', name: 'Georgia' },
  { value: 'Helvetica', name: 'Helvetica' },
  { value: 'Tahoma', name: 'Tahoma' },
  { value: 'Trebuchet MS', name: 'Trebuchet MS' },
  { value: 'Times New Roman', name: 'Times New Roman' },
  { value: 'Verdana', name: 'Verdana' },
  { value: 'Courier New', name: 'Courier New' },
  { value: 'sans-serif', name: 'sans-serif' },
  { value: 'serif', name: 'serif' },
  { value: 'monospace', name: 'monospace' },
  { value: 'inherit', name: 'inherit' },
];

const FONT_WEIGHTS = [
  { value: 'normal', name: 'Normal' },
  { value: 'bold', name: 'Bold' },
  { value: '100', name: 'Thin (100)' },
  { value: '200', name: 'Extra Light (200)' },
  { value: '300', name: 'Light (300)' },
  { value: '400', name: 'Regular (400)' },
  { value: '500', name: 'Medium (500)' },
  { value: '600', name: 'Semi Bold (600)' },
  { value: '700', name: 'Bold (700)' },
  { value: '800', name: 'Extra Bold (800)' },
  { value: '900', name: 'Black (900)' },
];

const FONT_STYLES = [
  { value: 'normal', name: 'Normal' },
  { value: 'italic', name: 'Italic' },
  { value: 'oblique', name: 'Oblique' },
];

const TEXT_ALIGNMENTS = [
  { value: 'left', name: 'Left' },
  { value: 'center', name: 'Center' },
  { value: 'right', name: 'Right' },
  { value: 'justify', name: 'Justify' },
];

const TEXT_DECORATIONS = [
  { value: 'none', name: 'None' },
  { value: 'underline', name: 'Underline' },
  { value: 'overline', name: 'Overline' },
  { value: 'line-through', name: 'Line-through' },
];

const BORDER_STYLES = [
  { value: 'none', name: 'None' },
  { value: 'solid', name: 'Solid' },
  { value: 'dotted', name: 'Dotted' },
  { value: 'dashed', name: 'Dashed' },
  { value: 'double', name: 'Double' },
];

// Curated Style Manager sectors for email-safe editing. Passing `sectors` in
// the init config REPLACES the default web-focused sectors.
const EMAIL_STYLE_SECTORS = [
  {
    id: 'email-text',
    name: 'Text',
    open: true,
    properties: [
      { id: 'font-family', property: 'font-family', label: 'Font', type: 'select', options: FONT_FAMILIES },
      { id: 'font-size', property: 'font-size', label: 'Font size', type: 'slider', units: ['px', 'em', 'rem', '%'], min: 6, max: 72, step: 1 },
      { id: 'font-weight', property: 'font-weight', label: 'Font weight', type: 'select', options: FONT_WEIGHTS },
      { id: 'font-style', property: 'font-style', label: 'Font style', type: 'select', options: FONT_STYLES },
      { id: 'line-height', property: 'line-height', label: 'Line height', type: 'slider', units: ['em', 'px', '%'], min: 0.8, max: 3, step: 0.1 },
      { id: 'letter-spacing', property: 'letter-spacing', label: 'Letter spacing', type: 'slider', units: ['px', 'em'], min: -3, max: 10, step: 0.5 },
      { id: 'color', property: 'color', label: 'Text color', type: 'color' },
      { id: 'text-align', property: 'text-align', label: 'Alignment', type: 'select', options: TEXT_ALIGNMENTS },
      { id: 'text-decoration', property: 'text-decoration', label: 'Decoration', type: 'select', options: TEXT_DECORATIONS },
    ],
  },
  {
    id: 'email-background',
    name: 'Background',
    open: false,
    properties: [
      { id: 'background-color', property: 'background-color', label: 'Background color', type: 'color' },
      { id: 'background-image', property: 'background-image', label: 'Image', type: 'file' },
      { id: 'background-size', property: 'background-size', label: 'Size', type: 'select', options: [
        { value: 'auto', name: 'Auto' },
        { value: 'cover', name: 'Cover' },
        { value: 'contain', name: 'Contain' },
        { value: '100% 100%', name: 'Stretch' },
      ] },
      { id: 'background-repeat', property: 'background-repeat', label: 'Repeat', type: 'select', options: [
        { value: 'no-repeat', name: 'No repeat' },
        { value: 'repeat', name: 'Repeat' },
        { value: 'repeat-x', name: 'Repeat X' },
        { value: 'repeat-y', name: 'Repeat Y' },
      ] },
      { id: 'background-position', property: 'background-position', label: 'Position', type: 'select', options: [
        { value: 'center', name: 'Center' },
        { value: 'top', name: 'Top' },
        { value: 'bottom', name: 'Bottom' },
        { value: 'left', name: 'Left' },
        { value: 'right', name: 'Right' },
        { value: 'top left', name: 'Top left' },
        { value: 'top right', name: 'Top right' },
        { value: 'bottom left', name: 'Bottom left' },
        { value: 'bottom right', name: 'Bottom right' },
      ] },
    ],
  },
  {
    id: 'email-spacing',
    name: 'Spacing & Size',
    open: false,
    properties: [
      { id: 'padding', property: 'padding', label: 'Padding', type: 'slider', units: ['px', 'em', 'rem', '%'], min: 0, max: 100 },
      { id: 'margin', property: 'margin', label: 'Margin', type: 'slider', units: ['px', 'em', 'rem', '%'], min: -50, max: 100 },
      { id: 'width', property: 'width', label: 'Width', type: 'slider', units: ['px', '%', 'em', 'rem'], min: 0, max: 1000 },
      { id: 'height', property: 'height', label: 'Height', type: 'slider', units: ['px', '%', 'em', 'rem'], min: 0, max: 1000 },
      { id: 'border-radius', property: 'border-radius', label: 'Border radius', type: 'slider', units: ['px', '%', 'em', 'rem'], min: 0, max: 100 },
      { id: 'border-style', property: 'border-style', label: 'Border style', type: 'select', options: BORDER_STYLES },
      { id: 'border-width', property: 'border-width', label: 'Border width', type: 'slider', units: ['px', 'em'], min: 0, max: 20 },
      { id: 'border-color', property: 'border-color', label: 'Border color', type: 'color' },
    ],
  },
];

// Drag-and-drop blocks for building/editing email layouts from scratch.
const EMAIL_BLOCKS = [
  {
    id: 'email-heading',
    label: 'Heading',
    category: 'Basic',
    media: '<i class="fa fa-header"></i>',
    content:
      '<h2 style="font-family: Arial, Helvetica, sans-serif; font-size: 24px; color: #1F2937; margin: 0 0 12px;">Add a heading</h2>',
  },
  {
    id: 'email-paragraph',
    label: 'Paragraph',
    category: 'Basic',
    media: '<i class="fa fa-paragraph"></i>',
    content:
      '<p style="font-family: Arial, Helvetica, sans-serif; font-size: 15px; color: #374151; line-height: 1.6; margin: 0 0 12px;">Write a paragraph of text. Placeholders like {{first_name}} are preserved automatically.</p>',
  },
  {
    id: 'email-text',
    label: 'Text',
    category: 'Basic',
    media: '<i class="fa fa-font"></i>',
    content:
      '<div style="font-family: Arial, Helvetica, sans-serif; font-size: 15px; color: #374151; line-height: 1.6; margin: 0 0 12px;">Rich text block — type anything, placeholders like {{company}} are kept.</div>',
  },
  {
    id: 'email-image',
    label: 'Image',
    category: 'Basic',
    media: '<i class="fa fa-image"></i>',
    content: {
      type: 'image',
      src: IMAGE_PLACEHOLDER,
      alt: 'Add an image',
      style: {
        display: 'block',
        maxWidth: '100%',
        height: 'auto',
        margin: '0 auto',
        border: '0',
      },
    },
  },
  {
    id: 'email-button',
    label: 'Button',
    category: 'Basic',
    media: '<i class="fa fa-external-link"></i>',
    content:
      '<a href="#" style="display: inline-block; font-family: Arial, Helvetica, sans-serif; font-size: 16px; font-weight: bold; color: #FFFFFF; background-color: #2563EB; border-radius: 6px; padding: 12px 24px; text-decoration: none; mso-padding-alt: 0;">Click here</a>',
  },
  {
    id: 'email-divider',
    label: 'Divider',
    category: 'Basic',
    media: '<i class="fa fa-minus"></i>',
    content: '<hr style="border: none; border-top: 1px solid #E5E7EB; margin: 16px 0;" />',
  },
  {
    id: 'email-spacer',
    label: 'Spacer',
    category: 'Basic',
    media: '<i class="fa fa-arrows-v"></i>',
    content: '<div style="height: 32px; line-height: 32px; font-size: 0;">&nbsp;</div>',
  },
];

// Custom GrapesJS plugin: registers the email blocks, image replace/toolbar
// affordances, and the asset-library toolbar button.
function emailEditorPlugin(
  editor: Editor,
  opts: { onError?: (message: string) => void } = {},
): void {
  const bm = editor.BlockManager;

  // Make the Button (rendered as an <a>, i.e. the built-in `link` component
  // type) resizable using the exact same mechanism the built-in `image` type
  // uses (`resizable: true`). We extend the existing `link` type so all of its
  // current behavior (selectable, draggable, editable, traits, clickable
  // <a>) is preserved — only resizable support is added. This keeps the Button
  // inside its Container/Section and lets the drag handles update its real
  // width/height, which is then serialized into the saved email HTML.
  const dc = editor.DomComponents;
  const linkType = dc.getType('link');
  if (linkType && linkType.model) {
    const linkDefaults =
      typeof (linkType.model as unknown as { getDefaults?: () => Record<string, unknown> }).getDefaults === 'function'
        ? (linkType.model as unknown as { getDefaults: () => Record<string, unknown> }).getDefaults()
        : (linkType.model.prototype as { defaults: Record<string, unknown> }).defaults;
    dc.addType('link', {
      model: {
        defaults: { ...linkDefaults, resizable: true },
      },
    });
  }

  for (const block of EMAIL_BLOCKS) {
    bm.add(block.id, {
      label: block.label,
      category: block.category,
      media: block.media,
      content: block.content,
      activate: true,
      select: true,
    });
  }

  // Double-clicking an image opens the system file picker directly, bypassing
  // the asset-manager modal. After the user picks an image it is uploaded and
  // set as the component's src.
  editor.on('component:dblclick', (component) => {
    if (!component || !component.is || !component.is('image')) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/jpg,image/webp,image/gif';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      document.body.removeChild(input);
      if (!file) return;
      try {
        const src = await uploadEmailImage(file);
        component.set('src', src);
      } catch (err) {
        opts.onError?.(err instanceof Error ? err.message : 'Failed to upload image.');
      }
    });
    input.addEventListener('cancel', () => {
      document.body.removeChild(input);
    });
    input.click();
  });

  // Add a "Replace" action to the toolbar of a selected image so users can swap
  // in an uploaded image without touching the source HTML.
  editor.on('component:selected', (component) => {
    if (!component || !component.is || !component.is('image')) return;
    const toolbar = component.get('toolbar') || [];
    if (!toolbar.some((btn) => btn && btn.id === 'email-replace-image')) {
      component.set('toolbar', [
        ...toolbar,
        {
          id: 'email-replace-image',
          label: 'Replace',
          attributes: { class: 'fa fa-image' },
          command: (ed) => ed.runCommand('open-assets', { target: ed.getSelected() }),
        },
      ]);
    }
  });

  // Reusable image library button next to the Blocks / Style Manager tabs.
  editor.Panels.addButton('views', {
    id: 'open-assets',
    className: 'fa fa-picture-o',
    command: 'open-assets',
    togglable: false,
    attributes: { title: 'Open image library' },
  });

  // Undo / redo shortcuts (the core command buttons are not part of the default UI).
  editor.Panels.addButton('options', {
    id: 'core-undo',
    className: 'fa fa-undo',
    command: 'core:undo',
    attributes: { title: 'Undo (Ctrl/Cmd+Z)' },
  });
  editor.Panels.addButton('options', {
    id: 'core-redo',
    className: 'fa fa-repeat',
    command: 'core:redo',
    attributes: { title: 'Redo (Ctrl/Cmd+Shift+Z)' },
  });
}

// Events that should mark the document as dirty and trigger a (debounced) sync.
const CHANGE_EVENTS = [
  'component:update',
  'component:add',
  'component:remove',
  'component:clone',
  'component:paste',
  'component:styleUpdate',
  'component:content',
  'style:update',
  'block:drag:stop',
  'trait:update',
  'asset:update',
  'undo',
  'redo',
];

/**
 * Serialize the GrapesJS wrapper back to a complete HTML document: doctype +
 * <html> + <head> (meta/title preserved from the original template) + <body> +
 * the CSS rules built by the Style Manager embedded in a <style> tag. GrapesJS
 * extracts <style> blocks into its CSS collection on load, so they must be
 * re-injected here or the saved template would silently lose its styles.
 */
function getDocumentHtml(editor: Editor): string {
  const wrapper = editor.getWrapper();
  if (!wrapper) return '';
  let html = wrapper.toHTML({ asDocument: true });
  const css = (editor.getCss() || '').trim();
  if (css) {
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, (head) => `${head}\n<style>${css}</style>`);
    } else if (/<body[^>]*>/i.test(html)) {
      html = html.replace(/<body[^>]*>/i, (body) => `<style>${css}</style>${body}`);
    }
  }
  return html;
}

/**
 * Full-featured visual email editor powered by GrapesJS. The template HTML is
 * loaded ONCE on mount (`initialHtml`), edits are reported via `onChange`, and
 * `getHtml()` (imperative handle) returns the up-to-date serialized document.
 * To load different content, re-mount the component (the parent keys it off the
 * active mode tab).
 */
const VisualEmailEditor = forwardRef<VisualEmailEditorHandle, VisualEmailEditorProps>(
  function VisualEmailEditor({ initialHtml, onChange, onError }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<Editor | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const destroyedRef = useRef(false);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;

    useImperativeHandle(
      ref,
      () => ({
        getHtml: () => (editorRef.current ? getDocumentHtml(editorRef.current) : ''),
      }),
      []
    );

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const styleEl = document.createElement('style');
      styleEl.textContent = TOOLBAR_CSS;
      document.head.appendChild(styleEl);

      destroyedRef.current = false;

      const editor = grapesjs.init({
        container,
        height: '650px',
        width: 'auto',
        fromElement: false,
        storageManager: false,
        plugins: [emailEditorPlugin],
        pluginsOpts: {
          emailEditorPlugin: {
            onError: (msg: string) => onErrorRef.current?.(msg),
          },
        },
        blockManager: {},
        styleManager: { sectors: EMAIL_STYLE_SECTORS },
        assetManager: {
          // A truthy `upload` value enables the upload form; the URL is never
          // used because uploadFile below performs the actual storage upload.
          upload: 'email-template',
          uploadName: 'files',
          embedAsBase64: false,
          autoAdd: true,
          assets: [],
          uploadFile: async (ev, clb) => {
            const input = ev.target as HTMLInputElement | null;
            const fileList = ev.dataTransfer ? ev.dataTransfer.files : input?.files;
            const files = Array.from(fileList ?? []).filter((f) => f.type.startsWith('image/'));
            const results: { src: string }[] = [];
            for (const file of files) {
              try {
                const src = await uploadEmailImage(file);
                results.push({ src });
              } catch (err) {
                editor.trigger(
                  'asset:upload:error',
                  err instanceof Error ? err : new Error(String(err))
                );
              }
            }
            if (clb) clb({ data: results });
            // When an image is selected in the canvas, immediately swap in the
            // first uploaded image (replace flow).
            const selected = editor.getSelected();
            if (selected && results[0]) {
              selected.set('src', results[0].src);
            }
          },
        },
      });

      editorRef.current = editor;

      const scheduleSync = () => {
        if (destroyedRef.current) return;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          if (destroyedRef.current) return;
          const current = editorRef.current;
          if (current) onChangeRef.current(getDocumentHtml(current));
        }, 250);
      };

      editor.on('asset:upload:error', (error) => {
        onErrorRef.current?.(error instanceof Error ? error.message : 'Failed to upload image.');
      });

      for (const evt of CHANGE_EVENTS) {
        editor.on(evt, scheduleSync);
      }

      // Load the template content (head/meta/title are preserved thanks to
      // asDocument parsing, and <style> rules move into the CSS collection).
      editor.setComponents(initialHtml || '', { asDocument: true });

      return () => {
        destroyedRef.current = true;
        if (timerRef.current) clearTimeout(timerRef.current);
        if (styleEl && styleEl.parentNode) {
          styleEl.parentNode.removeChild(styleEl);
        }
        // Flush any pending edit before the editor is torn down (e.g. when the
        // user switches to Source/Preview mode or unmounts the tab).
        if (editorRef.current) {
          onChangeRef.current(getDocumentHtml(editorRef.current));
        }
        editor.destroy();
        editorRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
      <div
        style={{
          flex: 1,
          minHeight: '650px',
          width: '100%',
          border: '1px solid #E2E8F0',
          borderRadius: '0 0 6px 6px',
          overflow: 'hidden',
          background: '#FFFFFF',
          boxSizing: 'border-box',
        }}
      >
        <div ref={containerRef} style={{ height: '100%' }} />
      </div>
    );
  }
);

export default VisualEmailEditor;