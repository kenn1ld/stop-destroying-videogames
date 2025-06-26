import adapter from '@sveltejs/adapter-node';
import preprocess from 'svelte-preprocess';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  // Enable Tailwind/postCSS processing via svelte-preprocess
  preprocess: preprocess({ postcss: true }),

  kit: {
    // Build a Node server into ./build for production
    adapter: adapter({ out: 'build' }),

    // If you host under a subpath, adjust base here
    // paths: { base: '/my-base' }
  }
};

export default config;
