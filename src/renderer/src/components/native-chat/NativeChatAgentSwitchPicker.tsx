import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import { NativeChatSessionOptionChoiceBody } from './NativeChatSessionOptionChoiceBody'
import { useNativeChatPickerFocusReturn } from './native-chat-picker-focus-return'

export type NativeChatAgentSwitchChoice = {
  id: string
  label: string
  description?: string
  unavailableReason?: string
}

/** Selection opens preparation; only the host's committed activation changes `active`. */
export type NativeChatAgentSwitchPickerProps = {
  active: NativeChatAgentSwitchChoice
  selected: NativeChatAgentSwitchChoice | null
  choices: readonly NativeChatAgentSwitchChoice[]
  busy: boolean
  onSelect: (id: string) => void
}
export function NativeChatAgentSwitchPicker(
  props: NativeChatAgentSwitchPickerProps
): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const focusReturn = useNativeChatPickerFocusReturn(undefined)
  const searchLabel = translate('components.native-chat.agentSwitch.search', 'Search agents…')
  return (
    <div className="flex min-w-0 flex-col items-end">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            ref={focusReturn.triggerRef}
            type="button"
            variant="ghost"
            size="xs"
            className="max-w-64"
            disabled={props.busy}
            aria-label={translate('components.native-chat.agentSwitch.label', 'Agent {{agent}}', {
              agent: props.active.label
            })}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && !props.busy) {
                event.preventDefault()
                setOpen(true)
              }
            }}
          >
            <span className="truncate text-chat-foreground">{props.active.label}</span>
            <ChevronDown className="size-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          collisionPadding={8}
          className="w-80 max-w-(--radix-popover-content-available-width)"
          onInteractOutside={focusReturn.onInteractOutside}
          onCloseAutoFocus={focusReturn.onCloseAutoFocus}
        >
          <Command
            surface="inline"
            density="menu"
            label={searchLabel}
            defaultValue={props.active.id}
          >
            <CommandInput aria-label={searchLabel} placeholder={searchLabel} />
            <CommandList aria-busy={props.busy}>
              <CommandEmpty>
                {translate(
                  'components.native-chat.agentSwitch.noMatch',
                  'No agents match your search.'
                )}
              </CommandEmpty>
              <CommandGroup>
                {props.choices.map((choice) => {
                  const current = choice.id === props.active.id
                  return (
                    <CommandItem
                      key={choice.id}
                      value={choice.id}
                      keywords={[choice.label, choice.description ?? '']}
                      selection="palette"
                      disabled={props.busy || !!choice.unavailableReason}
                      aria-current={current || undefined}
                      onSelect={() => {
                        if (props.busy || choice.unavailableReason || current) {
                          return
                        }
                        setOpen(false)
                        props.onSelect(choice.id)
                      }}
                    >
                      <div className="min-w-0">
                        <NativeChatSessionOptionChoiceBody
                          label={choice.label}
                          description={choice.description}
                        />
                        {choice.unavailableReason ? (
                          <div className="text-xs text-muted-foreground">
                            {choice.unavailableReason}
                          </div>
                        ) : null}
                      </div>
                      <span className="ml-auto flex size-3.5 shrink-0 items-center justify-center">
                        {current ? <Check className="size-3.5 text-muted-foreground" /> : null}
                      </span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {props.selected && props.selected.id !== props.active.id ? (
        <span role="status" className="max-w-64 truncate text-xs text-muted-foreground">
          {translate('components.native-chat.agentSwitch.selected', 'Selected: {{agent}}', {
            agent: props.selected.label
          })}
        </span>
      ) : null}
    </div>
  )
}
