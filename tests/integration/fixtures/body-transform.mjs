// A generic downstream text transformer, with no dependency on another composer.
export default {
  id: 'body-transform-fixture',
  server: async (_input, options = {}) => ({
    config(config) {
      // Hooks receive host-owned values; never mutate the native cache across instance reloads.
      config.agent = structuredClone(config.agent ?? {});
      config.command = structuredClone(config.command ?? {});
      if (options.agents !== false) {
        for (const agent of Object.values(config.agent ?? {})) {
          if (agent.disable !== true && typeof agent.prompt === 'string') {
            agent.prompt += '\nDOWNSTREAM_AGENT';
          }
        }
      }
      for (const command of Object.values(config.command ?? {})) {
        command.template += '\nDOWNSTREAM_COMMAND';
      }
    },
  }),
};
