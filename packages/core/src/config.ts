import type { PluginOption } from 'vite';
import type { Locale } from './locale/types';

export type OpenSlideBuildConfig = {
  showSlideBrowser?: boolean;
  showSlideUi?: boolean;
  allowHtmlDownload?: boolean;
};

export type OpenSlideEditorConfig = {
  /**
   * Save inspector edits on their own once editing pauses, instead of waiting
   * for Save. `true` waits 600 ms; a number sets the pause in milliseconds.
   * Text being typed is saved when the text editor closes.
   */
  autosave?: boolean | number;
};

export type OpenSlideAgentConfig = {
  enabled?: boolean;
};

export type OpenSlideConfig = {
  base?: string;
  slidesDir?: string;
  themesDir?: string;
  assetsDir?: string;
  port?: number;
  allowedHosts?: string[] | true;
  /**
   * @deprecated Pick the UI language from the language switcher in the slide UI
   * instead. When set, this only seeds the initial language until the user
   * chooses one (their choice is then remembered locally).
   */
  locale?: Locale;
  build?: OpenSlideBuildConfig;
  agent?: OpenSlideAgentConfig;
  editor?: OpenSlideEditorConfig;
  /** Extra Vite plugins, appended after open-slide's own. */
  vitePlugins?: PluginOption[];
};
