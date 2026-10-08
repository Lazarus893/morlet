"""Main PhoneAgent class for orchestrating phone automation."""

import json
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable

from phone_agent.actions import ActionHandler
from phone_agent.actions.handler import do, finish, parse_action
from phone_agent.companion import CompanionClient
from phone_agent.config import get_messages, get_system_prompt, load_experiences
from phone_agent.device_factory import get_device_factory
from phone_agent.model import ModelClient, ModelConfig
from phone_agent.model.client import MessageBuilder


@dataclass
class AgentConfig:
    """Configuration for the PhoneAgent."""

    max_steps: int = 100
    device_id: str | None = None
    lang: str = "cn"
    system_prompt: str | None = None
    verbose: bool = True
    planning_enabled: bool = True
    reflection_interval: int = 5
    experiences_dir: str | None = None
    # Companion APK settings
    companion_enabled: bool = False
    companion_apk_path: str | None = None
    overlay_enabled: bool = False

    def __post_init__(self):
        if self.system_prompt is None:
            self.system_prompt = get_system_prompt(self.lang)


@dataclass
class StepResult:
    """Result of a single agent step."""

    success: bool
    finished: bool
    action: dict[str, Any] | None
    thinking: str
    message: str | None = None


class PhoneAgent:
    """
    AI-powered agent for automating Android phone interactions.

    The agent uses a vision-language model to understand screen content
    and decide on actions to complete user tasks.

    Args:
        model_config: Configuration for the AI model.
        agent_config: Configuration for the agent behavior.
        confirmation_callback: Optional callback for sensitive action confirmation.
        takeover_callback: Optional callback for takeover requests.

    Example:
        >>> from phone_agent import PhoneAgent
        >>> from phone_agent.model import ModelConfig
        >>>
        >>> model_config = ModelConfig(base_url="http://localhost:8000/v1")
        >>> agent = PhoneAgent(model_config)
        >>> agent.run("Open WeChat and send a message to John")
    """

    def __init__(
        self,
        model_config: ModelConfig | None = None,
        agent_config: AgentConfig | None = None,
        confirmation_callback: Callable[[str], bool] | None = None,
        takeover_callback: Callable[[str], None] | None = None,
    ):
        self.model_config = model_config or ModelConfig()
        self.agent_config = agent_config or AgentConfig()

        # Initialize companion client if enabled
        self.companion: CompanionClient | None = None
        if self.agent_config.companion_enabled:
            self.companion = CompanionClient(
                device_id=self.agent_config.device_id,
                apk_path=self.agent_config.companion_apk_path,
            )
            # Override callbacks to use phone-side dialogs
            if confirmation_callback is None:
                confirmation_callback = self._companion_confirmation
            if takeover_callback is None:
                takeover_callback = self._companion_takeover

        self.model_client = ModelClient(self.model_config)
        self.action_handler = ActionHandler(
            device_id=self.agent_config.device_id,
            confirmation_callback=confirmation_callback,
            takeover_callback=takeover_callback,
        )

        self._context: list[dict[str, Any]] = []
        self._step_count = 0
        self._action_history: list[dict[str, Any]] = []
        self._task: str | None = None
        self._consecutive_loop_count = 0

    def run(self, task: str) -> str:
        """
        Run the agent to complete a task.

        Args:
            task: Natural language description of the task.

        Returns:
            Final message from the agent.
        """
        self._context = []
        self._step_count = 0
        self._action_history = []
        self._task = task

        # Setup companion if enabled
        if self.companion:
            try:
                self.companion.setup()
                if self.agent_config.overlay_enabled:
                    self.companion.overlay_on()
            except Exception as e:
                if self.agent_config.verbose:
                    print(f"⚠️ Companion setup failed: {e}")

        try:
            # First step with user prompt
            result = self._execute_step(task, is_first=True)

            if result.finished:
                return result.message or "Task completed"

            # Continue until finished or max steps reached
            while self._step_count < self.agent_config.max_steps:
                result = self._execute_step(is_first=False)

                if result.finished:
                    return result.message or "Task completed"

            return "Max steps reached"
        finally:
            # Always clean up overlay
            if self.companion and self.agent_config.overlay_enabled:
                try:
                    self.companion.overlay_off()
                except Exception:
                    pass

    def step(self, task: str | None = None) -> StepResult:
        """
        Execute a single step of the agent.

        Useful for manual control or debugging.

        Args:
            task: Task description (only needed for first step).

        Returns:
            StepResult with step details.
        """
        is_first = len(self._context) == 0

        if is_first and not task:
            raise ValueError("Task is required for the first step")

        if is_first and task:
            self._task = task

        return self._execute_step(task, is_first)

    def reset(self) -> None:
        """Reset the agent state for a new task."""
        self._context = []
        self._step_count = 0
        self._action_history = []
        self._task = None
        self._consecutive_loop_count = 0

    # --- Companion callbacks ---

    def _companion_confirmation(self, message: str) -> bool:
        """Confirmation callback that shows a dialog on the phone."""
        if not self.companion:
            return ActionHandler._default_confirmation(message)
        # Temporarily disable overlay so user can see the dialog
        was_overlay = self.companion.overlay_active
        if was_overlay:
            self.companion.overlay_off()
        try:
            result = self.companion.ask_yesno("操作确认", message, timeout=120.0)
            return result if result is not None else False
        finally:
            if was_overlay:
                self.companion.overlay_on()

    def _companion_takeover(self, message: str) -> None:
        """Takeover callback that notifies user on the phone and waits."""
        if not self.companion:
            ActionHandler._default_takeover(message)
            return
        # Disable overlay so user can operate the phone
        was_overlay = self.companion.overlay_active
        if was_overlay:
            self.companion.overlay_off()
        try:
            # Show dialog and wait for user to finish manual operation
            self.companion.show_dialog(
                title="需要手动操作",
                message=f"{message}\n\n完成后请点击确认",
                dialog_type="yesno",
                timeout=300.0,  # 5 min timeout for manual operations
            )
        finally:
            if was_overlay:
                self.companion.overlay_on()

    def _detect_loop(self) -> bool:
        """
        Detect if the last 3 actions are identical (potential loop).

        Returns:
            True if a loop is detected, False otherwise.
        """
        if len(self._action_history) < 3:
            return False
        last_3 = self._action_history[-3:]
        # Compare action dicts by their string representation
        is_loop = all(
            json.dumps(a, sort_keys=True, ensure_ascii=False)
            == json.dumps(last_3[0], sort_keys=True, ensure_ascii=False)
            for a in last_3
        )
        if is_loop:
            self._consecutive_loop_count += 1
        else:
            self._consecutive_loop_count = 0
        return is_loop

    def _should_force_skip_loop(self) -> bool:
        """
        If loop detected 3+ consecutive times (9+ identical actions),
        force the agent to move on.
        """
        return self._consecutive_loop_count >= 3

    def _execute_step(
        self, user_prompt: str | None = None, is_first: bool = False
    ) -> StepResult:
        """Execute a single step of the agent loop."""
        self._step_count += 1

        # Capture current screen state (with overlay hide-snap-show if active)
        device_factory = get_device_factory()

        def _take_screenshot():
            return device_factory.get_screenshot(self.agent_config.device_id)

        if self.companion and self.companion.overlay_active:
            screenshot = self.companion.screenshot_with_overlay(_take_screenshot)
        else:
            screenshot = _take_screenshot()

        current_app = device_factory.get_current_app(self.agent_config.device_id)

        # Build messages
        if is_first:
            # Build enhanced system prompt with experiences
            enhanced_prompt = self.agent_config.system_prompt
            if self.agent_config.planning_enabled:
                experiences = load_experiences(
                    task=user_prompt or "",
                    app_name=current_app or "",
                    experiences_dir=self.agent_config.experiences_dir,
                )
                if experiences:
                    enhanced_prompt += f"\n\n## 相关经验\n{experiences}"

            self._context.append(
                MessageBuilder.create_system_message(enhanced_prompt)
            )

            screen_info = MessageBuilder.build_screen_info(current_app)

            # Inject planning instruction on first step
            if self.agent_config.planning_enabled:
                planning_prefix = (
                    "请先在【分析】中制定简要的执行计划（3-5步），然后开始执行第一步。\n\n"
                )
                text_content = f"{planning_prefix}任务：{user_prompt}\n\n{screen_info}"
            else:
                text_content = f"{user_prompt}\n\n{screen_info}"

            self._context.append(
                MessageBuilder.create_user_message(
                    text=text_content, image_base64=screenshot.base64_data
                )
            )
        else:
            screen_info = MessageBuilder.build_screen_info(current_app)
            text_content = f"** Screen Info **\n\n{screen_info}"

            # Inject reflection hint every N steps
            reflection_interval = self.agent_config.reflection_interval
            if (
                reflection_interval > 0
                and self._step_count > 1
                and (self._step_count - 1) % reflection_interval == 0
            ):
                text_content += (
                    "\n\n【阶段检查】请在本次思考中回顾：\n"
                    "1. 任务完成了多少？还剩什么？\n"
                    "2. 是否偏离了原始目标？\n"
                    "3. 是否有更高效的路径？"
                )

            # Inject loop warning if detected
            if self._detect_loop():
                if self._should_force_skip_loop():
                    text_content += (
                        "\n\n🚨 严重循环警告：你已经连续9步以上执行相同操作，页面没有任何变化。"
                        "你必须立刻停止当前策略。请选择以下之一："
                        "\n1. 如果目标元素确实不存在，跳过此步骤，使用默认选项继续任务"
                        "\n2. 尝试一个完全不同的方法（如用搜索代替滑动）"
                        "\n3. 如果任务已无法继续，执行 finish 并说明原因"
                        "\n绝对不要再重复相同的操作。"
                    )
                else:
                    text_content += (
                        "\n\n⚠️ 检测到最近3步操作相同且页面无变化，"
                        "请重新分析页面结构，尝试不同的交互方式。"
                    )

            self._context.append(
                MessageBuilder.create_user_message(
                    text=text_content, image_base64=screenshot.base64_data
                )
            )

        # Get model response
        try:
            msgs = get_messages(self.agent_config.lang)
            print("\n" + "=" * 50)
            print(f"💭 {msgs['thinking']}:")
            print("-" * 50)
            response = self.model_client.request(self._context)
        except Exception as e:
            if self.agent_config.verbose:
                traceback.print_exc()
            return StepResult(
                success=False,
                finished=True,
                action=None,
                thinking="",
                message=f"Model error: {e}",
            )

        # Parse action from response
        try:
            action = parse_action(response.action)
        except ValueError:
            if self.agent_config.verbose:
                traceback.print_exc()
            action = finish(message=response.action)

        if self.agent_config.verbose:
            # Print thinking process
            print("-" * 50)
            print(f"🎯 {msgs['action']}:")
            print(json.dumps(action, ensure_ascii=False, indent=2))
            print("=" * 50 + "\n")

        # Record action to history for loop detection
        self._action_history.append(action)

        # Remove image from context to save space
        self._context[-1] = MessageBuilder.remove_images_from_message(self._context[-1])

        # Execute action
        try:
            result = self.action_handler.execute(
                action, screenshot.width, screenshot.height
            )
        except Exception as e:
            if self.agent_config.verbose:
                traceback.print_exc()
            result = self.action_handler.execute(
                finish(message=str(e)), screenshot.width, screenshot.height
            )

        # Add assistant response to context
        self._context.append(
            MessageBuilder.create_assistant_message(
                f"<think>{response.thinking}</think><answer>{response.action}</answer>"
            )
        )

        # Check if finished
        finished = action.get("_metadata") == "finish" or result.should_finish

        if finished and self.agent_config.verbose:
            msgs = get_messages(self.agent_config.lang)
            print("\n" + "🎉 " + "=" * 48)
            print(
                f"✅ {msgs['task_completed']}: {result.message or action.get('message', msgs['done'])}"
            )
            print("=" * 50 + "\n")

        return StepResult(
            success=result.success,
            finished=finished,
            action=action,
            thinking=response.thinking,
            message=result.message or action.get("message"),
        )

    @property
    def context(self) -> list[dict[str, Any]]:
        """Get the current conversation context."""
        return self._context.copy()

    @property
    def step_count(self) -> int:
        """Get the current step count."""
        return self._step_count

    @property
    def action_history(self) -> list[dict[str, Any]]:
        """Get the action history for debugging."""
        return self._action_history.copy()
