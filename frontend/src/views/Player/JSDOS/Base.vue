<script setup lang="ts">
import { useLocalStorage } from "@vueuse/core";
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import RomListItem from "@/components/common/Game/ListItem.vue";
import type { StateSchema } from "@/__generated__";
import { ROUTES } from "@/plugins/router";
import romApi from "@/services/api/rom";
import { stateApi } from "@/services/api/state";
import storeRoms, { type DetailedRom } from "@/stores/roms";
import type { DosProps, JsDosCI } from "@/types/jsdos";
import { getDownloadPath } from "@/utils";
import { saveJsDosState } from "./utils";

const { t } = useI18n();
const route = useRoute();
const romsStore = storeRoms();
const rom = ref<DetailedRom | null>(null);
const gameRunning = ref(false);
const fullScreenOnPlay = useLocalStorage("emulation.fullScreenOnPlay", true);
const scriptLoaded = ref(false);
const dosCI = ref<JsDosCI | null>(null);
const dosProps = ref<DosProps | null>(null);
const selectedState = ref<StateSchema | null>(null);
const saving = ref(false);
const jsDosStates = ref<StateSchema[]>([]);

async function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.body.appendChild(script);
  });
}

async function loadStylesheet(href: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error(`Failed to load ${href}`));
    document.head.appendChild(link);
  });
}

async function loadJsDos() {
  try {
    await Promise.all([
      loadStylesheet("/assets/jsdos/js-dos.css"),
      loadScript("/assets/jsdos/js-dos.js"),
    ]);
    scriptLoaded.value = true;
  } catch {
    try {
      await Promise.all([
        loadStylesheet("https://v8.js-dos.com/latest/js-dos.css"),
        loadScript("https://v8.js-dos.com/latest/js-dos.js"),
      ]);
      scriptLoaded.value = true;
    } catch (e) {
      console.error("[js-dos] Failed to load:", e);
    }
  }
}

function resetGameState() {
  gameRunning.value = false;
  dosCI.value = null;
  dosProps.value = null;
}

function onPlay() {
  gameRunning.value = true;

  nextTick(async () => {
    if (!rom.value) return;

    const container = document.getElementById("dos");
    if (!container) {
      console.error("[js-dos] Container #dos not found");
      return;
    }

    // Find .conf file in rom files and load its content
    const confFile = rom.value.files?.find((f: { file_name: string }) =>
      f.file_name.toLowerCase().endsWith(".conf"),
    );
    let dosboxConf: string | undefined;
    if (confFile) {
      try {
        const confUrl = getDownloadPath({
          rom: rom.value,
          fileIDs: [confFile.id],
        });
        const response = await fetch(confUrl);
        dosboxConf = await response.text();
        console.log("[js-dos] Loaded dosbox.conf, length:", dosboxConf.length);
      } catch (e) {
        console.error("[js-dos] Failed to load dosbox conf:", e);
      }
    }

    // Download persist data from server if a state is selected
    let persistData: Uint8Array | null = null;
    if (selectedState.value) {
      try {
        console.log(
          "[js-dos] Downloading state:",
          selectedState.value.file_name,
        );
        const { data } = await stateApi.get(
          selectedState.value.download_path.replace("/api", ""),
          { responseType: "arraybuffer" },
        );
        if (data) {
          persistData = new Uint8Array(data);
          console.log(
            "[js-dos] State data downloaded, size:",
            persistData.length,
            "starts with PK:",
            persistData[0] === 0x50 && persistData[1] === 0x4b,
          );
        }
      } catch (e) {
        console.error("[js-dos] Failed to download state:", e);
      }
    } else {
      console.log("[js-dos] No state selected, starting fresh");
    }

    // Use fsChanges.pull to provide server-side persist data as bundleChanges.
    // js-dos restores state via changesProducer → changesFromUrl → fsChanges.pull,
    // which loads it as bundles[1] (the changes layer).
    const fsChanges = persistData
      ? {
          pull: async (_key: string) => {
            console.log(
              "[js-dos] fsChanges.pull called, returning data size:",
              persistData!.length,
            );
            return persistData;
          },
          local: false,
        }
      : undefined;

    const romUrl = getDownloadPath({ rom: rom.value });
    console.log("[js-dos] Creating Dos instance, url:", romUrl);
    console.log("[js-dos] Options:", {
      hasDosboxConf: !!dosboxConf,
      hasFsChanges: !!fsChanges,
      autoStart: true,
    });

    const props = window.Dos(container as HTMLDivElement, {
      url: romUrl,
      autoStart: true,
      ...(dosboxConf ? { dosboxConf } : {}),
      ...(fsChanges ? { fsChanges } : {}),
      onEvent: (event: string, ci: JsDosCI) => {
        console.log("[js-dos] Event:", event);
        if (event === "ci-ready") {
          dosCI.value = ci;
          // Listen for internal exit to sync our state
          ci.events().onExit(() => {
            console.log("[js-dos] CI internal exit fired");
            resetGameState();
          });
        }
      },
    });
    dosProps.value = props;

    if (fullScreenOnPlay.value && document.fullscreenEnabled) {
      container.requestFullscreen?.();
    }
  });
}

function onFullScreenChange() {
  fullScreenOnPlay.value = !fullScreenOnPlay.value;
}

async function saveState() {
  if (!dosCI.value || !rom.value) return null;
  saving.value = true;
  try {
    // persist(true) returns changes-only ZIP, compatible with bundleChanges loading
    const persistData = await dosCI.value.persist(true);
    console.log(
      "[js-dos] persist(true) returned, size:",
      persistData?.length,
      "starts with PK:",
      persistData?.[0] === 0x50 && persistData?.[1] === 0x4b,
    );
    if (persistData && persistData.length > 0) {
      const saved = await saveJsDosState({
        rom: rom.value,
        stateFile: persistData,
      });
      if (saved) {
        jsDosStates.value.unshift(saved);
        selectedState.value = saved;
        romsStore.update(rom.value);
        console.log("[js-dos] State saved:", saved.file_name);
      }
      return saved;
    }
  } catch (e) {
    console.error("[js-dos] Failed to save state:", e);
  } finally {
    saving.value = false;
  }
  return null;
}

async function saveAndQuit() {
  await saveState();
  await onlyQuit();
}

async function onlyQuit() {
  if (dosCI.value) {
    await dosCI.value.exit();
  }
  resetGameState();
  window.history.back();
}

async function loadAndRestart(state: StateSchema | null) {
  if (dosCI.value) {
    await dosCI.value.exit();
  }
  resetGameState();
  selectedState.value = state;
  console.log(
    "[js-dos] Restarting with state:",
    state?.file_name ?? "New Game",
  );
  await nextTick();
  onPlay();
}

onMounted(async () => {
  const romResponse = await romApi.getRom({
    romId: parseInt(route.params.rom as string),
  });
  rom.value = romResponse.data;

  if (rom.value) {
    document.title = `${rom.value.name} | Play`;

    jsDosStates.value = rom.value.user_states.filter(
      (s) => s.emulator === "js-dos",
    );
    if (jsDosStates.value.length > 0) {
      selectedState.value = jsDosStates.value[0];
    }
    console.log(
      "[js-dos] Loaded",
      jsDosStates.value.length,
      "states, selected:",
      selectedState.value?.file_name ?? "none",
    );
  }

  await loadJsDos();
});

onUnmounted(() => {
  if (dosCI.value) {
    dosCI.value.exit();
  }
});
</script>

<template>
  <v-row v-if="rom" class="align-center justify-center scroll h-100" no-gutters>
    <v-col
      v-if="gameRunning"
      id="game-wrapper"
      cols="12"
      md="8"
      xl="10"
      class="bg-surface"
      rounded
    >
      <div id="dos" />
    </v-col>

    <v-col
      cols="12"
      :sm="!gameRunning ? 10 : 10"
      :md="!gameRunning ? 8 : 4"
      :xl="!gameRunning ? 6 : 2"
    >
      <v-row no-gutters>
        <v-col class="text-center">
          <v-icon size="x-large" color="primary">mdi-monitor</v-icon>
          <div class="text-h6 mt-2">js-dos</div>
        </v-col>
      </v-row>

      <v-divider class="my-4" />

      <v-row class="mb-4" no-gutters>
        <v-col>
          <RomListItem :rom="rom" with-filename with-size />
        </v-col>
      </v-row>

      <v-row class="px-3 text-center" no-gutters>
        <v-col>
          <v-row class="align-center ga-4" no-gutters>
            <v-col>
              <v-btn
                block
                size="large"
                :disabled="gameRunning"
                :variant="fullScreenOnPlay ? 'flat' : 'outlined'"
                :color="fullScreenOnPlay ? 'primary' : ''"
                @click="onFullScreenChange"
              >
                <v-icon class="mr-1">
                  {{
                    fullScreenOnPlay
                      ? "mdi-checkbox-outline"
                      : "mdi-checkbox-blank-outline"
                  }} </v-icon
                >{{ t("play.full-screen") }}
              </v-btn>
            </v-col>
            <v-col
              cols="12"
              :sm="gameRunning ? 12 : 7"
              :xl="gameRunning ? 12 : 9"
            >
              <v-btn
                color="primary"
                block
                :disabled="gameRunning || !scriptLoaded"
                variant="outlined"
                size="large"
                prepend-icon="mdi-play"
                @click="onPlay"
              >
                {{ t("play.play") }}
              </v-btn>
            </v-col>
          </v-row>

          <!-- State selector when not running -->
          <div v-if="!gameRunning" class="mt-4">
            <div class="text-caption text-medium-emphasis mb-1">
              {{ t("play.select-state") }}
            </div>
            <v-list
              v-if="jsDosStates.length > 0"
              density="compact"
              rounded="lg"
              variant="outlined"
              class="pa-0"
              max-height="180"
            >
              <v-list-item
                :active="!selectedState"
                @click="selectedState = null"
              >
                <v-list-item-title class="text-body-2">
                  {{ t("play.deselect-state") }}
                </v-list-item-title>
              </v-list-item>
              <v-list-item
                v-for="state in jsDosStates"
                :key="state.id"
                :active="selectedState?.id === state.id"
                @click="selectedState = state"
              >
                <v-list-item-title class="text-body-2 text-truncate">
                  {{ state.file_name }}
                </v-list-item-title>
                <v-list-item-subtitle class="text-caption">
                  {{
                    state.updated_at
                      ?.substring(0, 19)
                      .replace("T", " ")
                  }}
                </v-list-item-subtitle>
              </v-list-item>
            </v-list>
            <div v-else class="text-body-2 text-medium-emphasis">
              {{ t("play.no-states-available") }}
            </div>
          </div>

          <v-row v-if="!gameRunning" class="align-center ga-4 mt-4" no-gutters>
            <v-btn
              block
              variant="outlined"
              size="large"
              prepend-icon="mdi-arrow-left"
              @click="
                $router.push({
                  name: ROUTES.ROM,
                  params: { rom: rom?.id },
                })
              "
            >
              {{ t("play.back-to-game-details") }}
            </v-btn>
            <v-btn
              block
              variant="outlined"
              size="large"
              prepend-icon="mdi-arrow-left"
              @click="
                $router.push({
                  name: ROUTES.PLATFORM,
                  params: { platform: rom?.platform_id },
                })
              "
            >
              {{ t("play.back-to-gallery") }}
            </v-btn>
          </v-row>

          <!-- Controls when game is running -->
          <div v-if="gameRunning" class="mt-4">
            <v-btn
              block
              color="primary"
              variant="outlined"
              size="large"
              prepend-icon="mdi-content-save"
              :loading="saving"
              @click="saveState"
            >
              {{ t("play.save-state") }}
            </v-btn>
            <v-btn
              class="mt-2"
              block
              color="primary"
              variant="flat"
              size="large"
              prepend-icon="mdi-content-save"
              @click="saveAndQuit"
            >
              {{ t("play.save-and-quit") }}
            </v-btn>

            <!-- Load state list during gameplay -->
            <div class="mt-3">
              <div class="text-caption text-medium-emphasis mb-1">
                {{ t("play.load-state") }}
              </div>
              <v-list
                v-if="jsDosStates.length > 0"
                density="compact"
                rounded="lg"
                variant="outlined"
                class="pa-0"
                max-height="150"
              >
                <v-list-item @click="loadAndRestart(null)">
                  <template #prepend>
                    <v-icon size="small" class="mr-2">mdi-refresh</v-icon>
                  </template>
                  <v-list-item-title class="text-body-2">
                    {{ t("play.deselect-state") }}
                  </v-list-item-title>
                </v-list-item>
                <v-list-item
                  v-for="state in jsDosStates"
                  :key="state.id"
                  @click="loadAndRestart(state)"
                >
                  <template #prepend>
                    <v-icon size="small" class="mr-2">
                      mdi-folder-open
                    </v-icon>
                  </template>
                  <v-list-item-title class="text-body-2 text-truncate">
                    {{ state.file_name }}
                  </v-list-item-title>
                  <v-list-item-subtitle class="text-caption">
                    {{
                      state.updated_at
                        ?.substring(0, 19)
                        .replace("T", " ")
                    }}
                  </v-list-item-subtitle>
                </v-list-item>
              </v-list>
              <div v-else class="text-body-2 text-medium-emphasis">
                {{ t("play.no-states-available") }}
              </div>
            </div>

            <v-btn
              class="mt-3"
              block
              variant="outlined"
              size="large"
              prepend-icon="mdi-exit-to-app"
              @click="onlyQuit"
            >
              {{ t("play.quit") }}
            </v-btn>
          </div>
        </v-col>
      </v-row>
    </v-col>
  </v-row>
</template>

<style scoped>
#game-wrapper {
  height: 100%;
}

#dos {
  height: 100%;
  width: 100%;
}

@media (max-width: 960px) {
  #game-wrapper {
    height: calc(100vh - 55px);
  }
}
</style>
