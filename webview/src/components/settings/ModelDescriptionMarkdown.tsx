import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { memo, useEffect, useRef, useState } from "react"
import { useRemark } from "react-remark"
import styled from "styled-components"

const StyledMarkdown = styled.div`
  font-family: var(--vscode-font-family), system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen,
    Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);

  p,
  li,
  ol,
  ul {
    line-height: 1.25;
    margin: 0;
  }

  ol,
  ul {
    padding-left: 1.5em;
    margin-left: 0;
  }

  p {
    white-space: pre-wrap;
  }

  a {
    text-decoration: none;
  }
  a {
    &:hover {
      text-decoration: underline;
    }
  }
`

export const ModelDescriptionMarkdown = memo(
  ({
    markdown,
    key,
    isExpanded,
    setIsExpanded,
  }: {
    markdown?: string
    key: string
    isExpanded: boolean
    setIsExpanded: (isExpanded: boolean) => void
  }) => {
    const [reactContent, setMarkdown] = useRemark()
    // const [isExpanded, setIsExpanded] = useState(false)
    const [showSeeMore, setShowSeeMore] = useState(false)
    const textContainerRef = useRef<HTMLDivElement>(null)
    const textRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
      setMarkdown(markdown || "")
    }, [markdown, setMarkdown])

    useEffect(() => {
      if (textRef.current && textContainerRef.current) {
        const { scrollHeight } = textRef.current
        const { clientHeight } = textContainerRef.current
        const isOverflowing = scrollHeight > clientHeight
        setShowSeeMore(isOverflowing)
        // if (!isOverflowing) {
        // 	setIsExpanded(false)
        // }
      }
    }, [reactContent, setIsExpanded])

    return (
      <StyledMarkdown key={key} style={{ display: "inline-block", marginBottom: 0 }}>
        <div
          ref={textContainerRef}
          style={{
            overflowY: isExpanded ? "auto" : "hidden",
            position: "relative",
            wordBreak: "break-word",
            overflowWrap: "anywhere",
          }}>
          <div
            ref={textRef}
            style={{
              display: "-webkit-box",
              WebkitLineClamp: isExpanded ? "unset" : 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              // whiteSpace: "pre-wrap",
              // wordBreak: "break-word",
              // overflowWrap: "anywhere",
            }}>
            {reactContent}
          </div>
          {!isExpanded && showSeeMore && (
            <div
              style={{
                position: "absolute",
                right: 0,
                bottom: 0,
                display: "flex",
                alignItems: "center",
              }}>
              <div
                style={{
                  width: 30,
                  height: "1.2em",
                  background: "linear-gradient(to right, transparent, var(--vscode-sideBar-background))",
                }}
              />
              <VSCodeLink
                style={{
                  // cursor: "pointer",
                  // color: "var(--vscode-textLink-foreground)",
                  fontSize: "inherit",
                  paddingRight: 0,
                  paddingLeft: 3,
                  backgroundColor: "var(--vscode-sideBar-background)",
                }}
                onClick={() => setIsExpanded(true)}>
                See more
              </VSCodeLink>
            </div>
          )}
        </div>
      </StyledMarkdown>
    )
  }
)